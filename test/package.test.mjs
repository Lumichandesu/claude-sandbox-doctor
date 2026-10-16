// The package, held to what it says: the one skill, what the sources may do, where the engine files come from, and the workflows.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, exists, read, sources, walk } from "./helpers.mjs";
import { parseArgs } from "../src/cli.mjs";

// ---- the skill ------------------------------------------------------------------------------------------------------------------

test("one skill, /sandbox-doctor:check: user-only, a description of three words, allowed to run this tool and nothing wider", () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "skills")), ["check"]);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "skills", "check")), ["SKILL.md"]);
  const text = read("skills/check/SKILL.md");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, "has frontmatter");
  assert.match(front[1], /^name: check$/m);
  assert.match(front[1], /^disable-model-invocation: true$/m);
  const desc = /^description: (.+)$/m.exec(front[1])[1];
  assert.equal(desc, "Check the sandbox.", "the hub's plugins share an always-on limit of 200 tokens");
  assert.ok(desc.length <= 30, `${desc.length} characters`);
  const allowed = /^allowed-tools: (.+)$/m.exec(front[1])[1];
  const rules = allowed.split(/\s(?=(?:Bash|PowerShell)\()/);
  assert.equal(rules.length, 4);
  for (const rule of rules) assert.match(rule, /^(Bash|PowerShell)\(node "?\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-sandbox-doctor\.mjs"? \*\)$/, rule);
  assert.ok(rules.some((r) => r.startsWith("Bash(")) && rules.some((r) => r.startsWith("PowerShell(")), "for whichever shell tool Claude Code has");
  assert.doesNotMatch(allowed, /Bash\(\*\)|Edit|Write|WebFetch/, "nothing wider than the one command");
});

test("the skill runs lint --markdown for the project and check --markdown, once each, and asks for at most 10 lines and no edit before the user agrees", () => {
  const text = read("skills/check/SKILL.md");
  const body = text.slice(/^---\n[\s\S]*?\n---\n/.exec(text)[0].length);
  const commands = [...body.matchAll(/^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-sandbox-doctor\.mjs" (.+)`$/gm)].map((m) => m[1]);
  assert.equal(commands.length, 2, "two command lines, which Claude Code runs or hands to the model");
  const [lint, check] = commands.map((c) => parseArgs(c.replace(/"\$\{CLAUDE_PROJECT_DIR\}"/g, "dir").split(/\s+/)));
  assert.equal(lint.command, "lint");
  assert.equal(lint.markdown, true);
  assert.equal(lint.project, "dir");
  assert.equal(check.command, "check");
  assert.equal(check.markdown, true);
  assert.equal(check.live, false, "the skill never runs the real binary");
  assert.match(body, /At most 10 lines: whether the sandbox can work on this machine, and each setting that can never take effect with its file and the fix\./);
  assert.match(body, /If both are clean, say so in one line\./);
  assert.match(body, /Edit nothing until the user agrees\./);
  assert.ok(!/\$\{CLAUDE_SKILL_DIR\}|\$ARGUMENTS/.test(body));
  assert.ok(body.length < 800, `the instructions and command lines are ${body.length} characters; each use pays for them`);
});

// ---- what the sources may do -------------------------------------------------------------------------------------------------------

test("only src/host.mjs and src/live.mjs start a program, only src/live.mjs opens a connection, and nothing can run code it was handed", () => {
  const startsProcess = /node:child_process|(?<![.\w])(spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(/;
  const opensConnection = /node:(http|https|http2|net|tls|dns|dgram)\b|(?<![.\w])(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/;
  const runsCode = /node:(worker_threads|cluster|vm)\b|\bprocess\.binding\b|\beval\s*\(|new Function\s*\(/;
  for (const f of sources()) {
    const text = read(f);
    if (!["src/host.mjs", "src/live.mjs"].includes(f)) assert.doesNotMatch(text, startsProcess, `${f} must not start a program: only src/host.mjs and src/live.mjs do`);
    if (f !== "src/live.mjs") assert.doesNotMatch(text, opensConnection, `${f} must not open a connection: only src/live.mjs does`);
    assert.doesNotMatch(text, runsCode, f);
  }
  assert.match(read("src/host.mjs"), /node:child_process/);
  assert.match(read("src/live.mjs"), /node:http/);
  assert.match(read("src/live.mjs"), /node:child_process/);
  assert.doesNotMatch(read("src/host.mjs"), /node:(http|https|net)/);
});

test("src/live.mjs is the only code that writes: nothing else in the package calls a function that changes a file", () => {
  const writes = /\b(?:writeFile|appendFile|copyFile|rename|unlink|rmdir|rm|mkdir|mkdtemp|truncate|symlink|link|chmod|utimes)(?:Sync)?\s*\(|\bcreateWriteStream\b|\bfs\.promises\b/;
  for (const f of sources()) {
    if (f === "src/live.mjs") continue;
    assert.doesNotMatch(read(f), writes, `${f} must not write: only src/live.mjs does (its throwaway folder)`);
  }
  const live = read("src/live.mjs");
  assert.match(live, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\)/, "it writes in the temporary folder");
  assert.match(live, /fs\.rmSync\(root, \{ recursive: true, force: true \}\)/, "and removes what it made");
});

test("the engine files say where they were copied from, and carry the version of Claude Code they were checked against", () => {
  for (const f of walk("src/engine", ".mjs")) {
    const head = read(f).split("\n").slice(0, 2).join("\n");
    assert.match(head, /^\/\/ Copied unchanged from claude-permission-doctor \(src\/[a-z]+\.mjs at commit [0-9a-f]{7}, MIT, the same author\), by way of claude-automode-doctor,/, f);
    assert.match(head, /Claude Code 2\.1\.\d+/, f);
  }
  assert.ok(exists("src/jsonc.mjs"));
});

// ---- the workflows -----------------------------------------------------------------------------------------------------------------

test("the CI workflows: the suite on three systems and four Node versions, the real binary on Linux with and without bubblewrap and on macOS, no action version pinned here", () => {
  const ci = read(".github/workflows/test.yml");
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(ci, /node: \[20, 22, 24\]/);
  assert.match(ci, /node: 18/);
  assert.match(ci, /run: npm test/);
  assert.match(ci, /uses: actions\/checkout@/);
  assert.match(ci, /uses: actions\/setup-node@/);
  assert.match(ci, /timeout-minutes: \d+/);
  const e2e = read(".github/workflows/e2e.yml");
  for (const part of ["name: e2e", "ubuntu-latest", "macos-latest", "apt-get install -y bubblewrap socat", "apt-get remove -y bubblewrap socat", "npm install -g @anthropic-ai/claude-code@${{ inputs.claude_version || 'latest' }}", "claude_version:", "continue-on-error: true", "E2E_CLAUDE: claude", "CSD_E2E_MANAGED: \"1\"", "schedule:", "workflow_dispatch"]) assert.ok(e2e.includes(part), part);
  assert.match(e2e, /timeout-minutes: \d+/);
  assert.ok(!e2e.includes("windows"), "the sandbox does not exist on Windows: no job for it");
  // every real-binary test file runs in some step
  for (const f of walk("test", ".mjs").filter((n) => /e2e-.*\.test\.mjs$/.test(n))) assert.ok(e2e.includes(f), `${f} runs in a workflow step`);
  const steps = e2e.split(/\n {6}- /);
  // the managed one runs alone in its step, once for Linux and once for macOS: the folder it writes is the machine's
  const managed = steps.filter((s) => s.includes("test/e2e-managed.test.mjs"));
  assert.equal(managed.length, 2);
  for (const s of managed) assert.equal((s.match(/test\/e2e-[a-z-]+\.test\.mjs/g) || []).length, 1, "alone in its step");
  // the install may fail (the checks then skip); the checks themselves may not hide a failure
  const install = steps.filter((s) => s.includes("npm install -g"));
  assert.equal(install.length, 3);
  for (const s of install) assert.match(s, /continue-on-error: true/);
  for (const s of steps.filter((x) => /node --test/.test(x))) assert.doesNotMatch(s, /continue-on-error/);
});
