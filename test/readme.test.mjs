// The README, held to the code: its sections, the commands and options it names, the usage block, the numbers it quotes, the tables of
// rules and reasons, the JSON shapes, the examples (they are what the code prints), the Files table and the toolkit list.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, exists, put, read, run, sources, walk, world } from "./helpers.mjs";
import { MAC, WINDOWS, ubuntu } from "./fakesys.mjs";
import { RULES } from "../src/lint.mjs";
import { REASONS } from "../src/exclusion.mjs";
import { approvals, managedRows, tableRows } from "./why-table.mjs";
import { groups as domainGroups, requests as domainRequests } from "./domain-table.mjs";

const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
const readme = read("README.md");

const README_SECTIONS = ["## What you get", "## What it costs in tokens", "## Install", "## Use", "## How it works", "## What was verified, and how", "## Not verified", "## Files", "## Contributing", "## Part of the Claude Code toolkit", "## License"];
const TOOLKIT = [
  "- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself",
  "- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers",
  "- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD",
  "- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits",
  "- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes",
  "- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings",
  "- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it",
  "- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command",
  "- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay",
  "- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them",
  "- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history",
  "- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep",
  "- [claude-hook-bench](https://github.com/nrzz/claude-hook-bench): run every hook with the JSON Claude Code sends, and see what each one does",
  "- [claude-relocate](https://github.com/nrzz/claude-relocate): move Claude Code's config folder to another drive or the XDG folders, safely, with undo",
  "- [claude-settings-doctor](https://github.com/nrzz/claude-settings-doctor): a commented settings.jsonc that builds settings.json, the merged settings with their source, a lint against the schema",
  "- [claude-automode-doctor](https://github.com/nrzz/claude-automode-doctor): what auto mode and its classifier decided, from your transcripts, plus a lint of the autoMode settings",
  "- [claude-mcp-check](https://github.com/nrzz/claude-mcp-check): every MCP server Claude Code would load, from which file, whether it starts, and what its tools cost",
  "- [claude-windows-doctor](https://github.com/nrzz/claude-windows-doctor): which shell the Bash tool gets on Windows and why, every claude on PATH, and the setup problems behind common Windows issues",
];

test("the README has the sections the house keeps, in order, and the Privacy heading the plugin manifest links to", () => {
  let at = -1;
  for (const h of README_SECTIONS) {
    const i = readme.indexOf(`\n${h}\n`);
    assert.ok(i > at, `${h} is there, after the one before it`);
    at = i;
  }
  assert.match(readme, /^# claude-sandbox-doctor\n/);
  assert.ok(readme.indexOf("\n### Privacy\n") > readme.indexOf("\n## How it works\n") && readme.indexOf("\n### Privacy\n") < readme.indexOf("\n## What was verified, and how\n"), "### Privacy sits under How it works");
  assert.ok(plugin.privacyPolicyUrl.endsWith("#privacy"));
});

test("the README names every command and option the CLI has, the install lines, the numbers of the opening paragraph and the skill", () => {
  for (const cmd of ["check", "show", "why", "lint"]) assert.ok(readme.includes(`### \`${cmd}\``), `a heading for ${cmd}`);
  for (const flag of ["--live", "--claude", "--markdown", "--project", "--retry", "--json", "--no-color"]) assert.ok(readme.includes(`\`${flag}`), flag);
  for (const cmd of ["claude-sandbox-doctor check", "claude-sandbox-doctor show", "claude-sandbox-doctor why", "claude-sandbox-doctor lint"]) assert.ok(readme.includes(cmd), cmd);
  assert.ok(readme.includes("npx -y github:nrzz/claude-sandbox-doctor check"));
  assert.ok(readme.includes("git clone https://github.com/nrzz/claude-sandbox-doctor"));
  assert.ok(readme.includes("/plugin marketplace add nrzz/claude-code-toolkit"));
  assert.ok(readme.includes("/plugin install sandbox-doctor@claude-code-toolkit"));
  assert.ok(readme.includes("/sandbox-doctor:check"));
  const opening = readme.slice(0, readme.indexOf("\n## What you get\n"));
  for (const number of ["202 open issues", "276", "#99680", "#43454", "54 reactions", "#28018", "80 reactions", "#95532", "#95455", "16 October 2026"]) assert.ok(opening.includes(number), number);
  assert.ok(!/\p{Extended_Pictographic}/u.test(readme), "no emoji");
  assert.ok(!/\b(simply|easily|blazing|seamless|powerful|amazing|revolutionary)\b/i.test(readme), "plain words");
});

test("the toolkit list: the fourteen lines, settings-doctor, automode-doctor, mcp-check, windows-doctor, the page line and the star line; this tool is not in its own list", () => {
  const section = readme.slice(readme.indexOf("\n## Part of the Claude Code toolkit\n"), readme.indexOf("\n## License\n"));
  const lines = section.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines, TOOLKIT);
  assert.ok(!section.includes("claude-sandbox-doctor"), "not in its own list");
  assert.ok(section.includes("Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on."));
  assert.ok(section.includes("If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases."));
});

test("the links in the README that point into the repository go to files that are there", () => {
  for (const m of readme.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) assert.ok(exists(m[1].split("#")[0]), `${m[1]} is linked and exists`);
});

test("the usage block of the README is the help text of the CLI, and nothing is left to fill in", async () => {
  const help = (await run(["--help"], world("readme-help"))).out;
  const usage = help.slice(help.indexOf("Usage: claude-sandbox-doctor")).trimEnd();
  assert.ok(readme.includes(usage), "the README's usage block is out of date: paste the output of claude-sandbox-doctor --help from its Usage line");
  assert.ok(!readme.includes("@@"), "a placeholder is still in the README");
});

test("the numbers the README quotes are the numbers of the code and of the tables: the skill, the cap of the report, the rows, the requests", async () => {
  const skill = read("skills/check/SKILL.md");
  const body = skill.slice(/^---\n[\s\S]*?\n---\n/.exec(skill)[0].length);
  const instruction = body.split("\n").filter((l) => l && !l.startsWith("!`")).join("\n");
  assert.ok(readme.includes(`${instruction.length}-character instruction`), `the instruction is ${instruction.length} characters`);
  const desc = /^description: (.+)$/m.exec(skill)[1];
  assert.ok(readme.includes(`\`${desc}\`: ${desc.length} characters`), `the description is ${desc.length} characters`);
  assert.ok(readme.includes("at most 12 findings") && readme.includes("300 characters"));
  // the cap: 12 findings of a worst case world
  const w = world("readme-cap");
  w.user({ sandbox: { enabled: true, excludedCommands: Array.from({ length: 30 }, (_, i) => `bare${i}`) } });
  const md = (await run(["lint", "--markdown"], w, { sys: ubuntu({ profile: true }) })).out;
  assert.equal(md.split("\n").filter((l) => l.startsWith("- WARNING")).length, 12);
  // the tables the claims rest on
  assert.ok(tableRows.length >= 100, "more than a hundred rows");
  assert.ok(readme.includes(`${tableRows.length} calls`), `the table has ${tableRows.length} calls`);
  assert.ok(readme.includes(`${approvals.length} approval rows`), `the approval table has ${approvals.length} rows`);
  assert.ok(readme.includes(`${managedRows.length} rows with managed settings`), `the managed table has ${managedRows.length} rows`);
  assert.ok(readme.includes(`${domainRequests.length} requests`) && readme.includes(`${domainGroups.length} entries or sets of entries`), `the domain table has ${domainRequests.length} requests in ${domainGroups.length} groups`);
});

test("the number of tests the README states is the runner's total minus the helper files that node --test lists as tests", { skip: process.env.CSD_COUNTING && "this is the run that counts" }, () => {
  const env = { ...process.env, CSD_COUNTING: "1" };
  delete env.E2E_CLAUDE;
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test"], { cwd: ROOT, env, encoding: "utf8", timeout: 600000, windowsHide: true });
  const total = Number((/^(?:# |ℹ )tests (\d+)$/m.exec(r.stdout) || [])[1]);
  assert.ok(total > 100, `the runner reported ${total} tests:\n${r.stdout.slice(-600)}`);
  const helpers = fs.readdirSync(path.join(ROOT, "test")).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs")).length;
  const counted = total - helpers;
  const stated = /\*\*(\d+) automated tests\*\*/.exec(readme);
  assert.ok(stated, "the README says how many automated tests there are");
  assert.equal(Number(stated[1]), counted, `the runner reported ${total}, of which ${helpers} are helper files: ${counted} tests`);
  assert.ok(readme.includes(`each of the ${helpers} helper files`), `the README names the ${helpers} helper files`);
  // this test is skipped in the run that counted it, and passes in the run of the README's reader
  const skipped = Number((/^(?:# |ℹ )skipped (\d+)$/m.exec(r.stdout) || [])[1]) - 1;
  const passed = Number((/^(?:# |ℹ )pass (\d+)$/m.exec(r.stdout) || [])[1]) + 1 - helpers;
  assert.equal(passed + skipped, counted, "every test passes or is skipped");
  assert.ok(readme.includes(`${passed} pass and ${skipped} are skipped`), `the README says "${passed} pass and ${skipped} are skipped"`);
});

// ---- the tables of rules and reasons ------------------------------------------------------------------------------------------------

const tableRowsOf = (text, start, end) => {
  const section = text.slice(text.indexOf(start), end ? text.indexOf(end, text.indexOf(start)) : undefined);
  return [...section.matchAll(/^\| `([a-z-]+)` \| (.+) \|$/gm)].map((m) => ({ id: m[1], cells: m[2] }));
};

test("the README lists every finding that lint can emit, with the severity, the basis and the words of RULES, and no other", () => {
  const rows = [...readme.slice(readme.indexOf("### What `lint` finds")).matchAll(/^\| `([a-z0-9-]+)` \| (error|warning|note) \| (binary|docs|mixed) \| (.+) \|$/gm)].map((m) => ({ id: m[1], severity: m[2], basis: m[3], what: m[4] }));
  assert.deepEqual(rows.map((r) => r.id), Object.keys(RULES), "the ids of the README and of RULES are the same, in the same order");
  for (const r of rows) assert.deepEqual({ severity: r.severity, basis: r.basis, what: r.what }, { severity: RULES[r.id].severity, basis: RULES[r.id].basis, what: RULES[r.id].what }, r.id);
  const emitted = [...new Set(sources().flatMap((f) => [...read(f).matchAll(/\bid: "([a-z]+(?:-[a-z]+)*)"/g)].map((m) => m[1])))].filter((id) => !["inside", "write", "network"].includes(id));
  for (const id of emitted.filter((x) => /^(?:[a-z]+-)+[a-z]+$|^[a-z]+$/.test(x))) assert.ok(id in RULES || !read("src/lint.mjs").includes(`id: "${id}"`), `${id} is emitted by lint and is a rule`);
});

test("the README lists every reason why a call stays inside the sandbox in spite of an entry, with the words of the code", () => {
  const section = readme.slice(readme.indexOf("#### Why a call stays inside the sandbox in spite of an entry"), readme.indexOf("### What `check` tries"));
  const rows = [...section.matchAll(/^\| `([a-z-]+)` \| (.+) \|$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, Object.entries(REASONS));
});

// ---- the JSON documents -------------------------------------------------------------------------------------------------------------

/** The shapes of the README: { field, field?, field: { ... }, field: [ { ... } ], <key>: ... } into a tree. */
function parseShape(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const value = () => {
    ws();
    const nul = /^null\s*\|\s*/.exec(text.slice(i));
    if (nul) i += nul[0].length;
    if (text[i] === "{") return object();
    if (text[i] === "[") {
      i++; ws();
      let item = { kind: "leaf" };
      if (text[i] === "{") item = object();
      ws();
      if (text[i] !== "]") throw new Error(`] expected at: ${text.slice(i, i + 40)}`);
      i++;
      return { kind: "list", item };
    }
    throw new Error(`a { or a [ expected at: ${text.slice(i, i + 40)}`);
  };
  const object = () => {
    i++;
    const fields = {};
    for (;;) {
      ws();
      if (text[i] === "}") { i++; return { kind: "object", fields }; }
      if (text[i] === ",") { i++; continue; }
      const m = /^(<[a-z]+>|[A-Za-z_][A-Za-z0-9_]*)(\?)?/.exec(text.slice(i));
      if (!m) throw new Error(`a field name expected at: ${text.slice(i, i + 40)}`);
      i += m[0].length; ws();
      let node = { kind: "leaf" };
      if (text[i] === ":") { i++; node = value(); }
      fields[m[1]] = { optional: Boolean(m[2]), node };
    }
  };
  return value();
}

/** Hold the documents to a shape: every key of a document is in the shape, every key of the shape that is not optional is in some document. */
function holdTo(node, samples, where, errors) {
  if (node.kind === "object") {
    const objects = samples.filter((v) => v && typeof v === "object" && !Array.isArray(v));
    const named = Object.keys(node.fields).filter((k) => !k.startsWith("<"));
    const wildcard = Object.keys(node.fields).find((k) => k.startsWith("<"));
    const seen = new Set();
    for (const o of objects) {
      for (const k of Object.keys(o)) {
        seen.add(k);
        if (!named.includes(k) && !wildcard) errors.push(`${where}: "${k}" is in a document and not in the README shape`);
      }
    }
    for (const name of named) {
      const spec = node.fields[name];
      if (!spec.optional && !seen.has(name)) errors.push(`${where}: "${name}" is in the README shape and in no document (mark it with ? if it is optional)`);
      if (spec.node.kind !== "leaf") holdTo(spec.node, objects.map((o) => o[name]).filter((v) => v !== undefined && v !== null), `${where}.${name}`, errors);
    }
    if (wildcard && node.fields[wildcard].node.kind !== "leaf") {
      const rest = objects.flatMap((o) => Object.entries(o).filter(([k]) => !named.includes(k)).map(([, v]) => v));
      holdTo(node.fields[wildcard].node, rest, `${where}.${wildcard}`, errors);
    }
  } else if (node.kind === "list") {
    const items = samples.filter(Array.isArray).flat();
    if (node.item.kind !== "leaf") holdTo(node.item, items, `${where}[]`, errors);
  }
}

const copyExample = (w, name) => {
  const dir = path.join(w.base, name);
  put(path.join(dir, ".claude", "settings.json"), read(`examples/${name}/.claude/settings.json`));
  return dir;
};

async function documents() {
  const docs = { check: [], show: [], why: [], lint: [] };
  const fakeClaude = path.join(ROOT, "test", "fake-claude.mjs");
  void fakeClaude;
  // check: a healthy machine, a broken one, one without the programs, a Mac, Windows, and the live part in its three forms
  for (const sys of [ubuntu({ profile: true }), ubuntu({ profile: false }), ubuntu({ bwrap: false, socat: false }), MAC(), WINDOWS()]) docs.check.push((await run(["check", "--json"], world("shape-check"), { sys })).json());
  const okLive = { version: "2.1.301 (Claude Code)", ok: true, stderr: "", exit: 0, warnings: [], startError: null, probes: [{ id: "inside", title: "t", command: "c", outcome: "inside", evidence: "e", decision: "accept", text: "1" }] };
  const sysLive = ubuntu({ profile: true });
  const existed = sysLive.exists;
  sysLive.exists = (p) => existed(p) || p === process.execPath; // a claude that exists
  docs.check.push((await run(["check", "--live", "--json", "--claude", process.execPath], world("shape-live"), { sys: sysLive, runLive: async () => okLive })).json());
  docs.check.push((await run(["check", "--live", "--json", "--claude", path.join(ROOT, "no-such-claude")], world("shape-live2"), { sys: ubuntu({ profile: true }) })).json());
  docs.check.push((await run(["check", "--live", "--json"], world("shape-live3"), { sys: WINDOWS() })).json());
  // show and lint: the example project; a world with every kind of file; a file that Claude Code drops; an admin-required sandbox
  const sysU = ubuntu({ profile: true });
  const a = world("shape-a");
  const shop = copyExample(a, "shop");
  for (const command of ["show", "lint"]) docs[command].push((await run([command, "--json", "--project", shop], a, { sys: sysU })).json());
  const b = world("shape-b");
  b.managed({ sandbox: { enabled: true, allowUnsandboxedCommands: false, enabledPlatforms: ["linux"], network: { allowManagedDomainsOnly: true, allowedDomains: ["a.example.com"] } } });
  b.user({ sandbox: { failIfUnavailable: true, excludedCommands: ["docker *"] }, permissions: { deny: ["Read(./secrets/**)"], additionalDirectories: ["../shared"] } });
  b.project({ sandbox: { excludedCommands: ["git status", "docker *"], allowUnsandboxedCommands: true, network: { allowedDomains: ["b.example.com"], deniedDomains: ["c.example.com"] }, enableWeakerNestedSandbox: true, filesystem: { allowWrite: ["./out"], denyRead: ["~/.ssh"] }, credentials: { files: [{ path: "~/.aws/credentials", mode: "mask" }] } } });
  b.local('{ // a comment: Claude Code drops the file\n "sandbox": { "enabled": false } }');
  for (const command of ["show", "lint"]) docs[command].push((await run([command, "--json"], b, { sys: sysU })).json());
  const c = world("shape-c");
  c.user({ sandbox: { enabled: "yes", excludedCommands: "docker", enableWeakerNestedSandbx: true, bwrapPath: "x", autoAllowBashIfSandboxed: true, enabledPlatforms: ["mac"] } });
  c.project({ sandbox: { enabled: true, failIfUnavailable: true, bwrapPath: "/opt/bwrap", allowAppleEvents: true, network: { allowedDomains: ["::1:443", "https://x", "*.y.com"] } } });
  for (const command of ["show", "lint"]) docs[command].push((await run([command, "--json"], c, { sys: ubuntu({ bwrap: false, socat: false }) })).json());
  docs.lint.push((await run(["lint", "--json"], world("shape-d"), { sys: WINDOWS() })).json());
  // why: an excluded call, one that stays inside, a shape, a retry that is honored and one that is refused, a rule that denies, one that allows
  const locked = copyExample(a, "locked");
  for (const [command, extra, project] of [["docker compose up -d", [], shop], ["docker ps", [], shop], ["cd infra && terraform plan", [], shop], ["npm run build > build.log", [], shop], ["npm test", ["--retry"], shop], ["npm test", ["--retry"], locked], ["gh pr list", [], locked], ["docker ps", [], null]]) {
    docs.why.push((await run(["why", command, "--json", ...extra, ...(project ? ["--project", project] : [])], b, { sys: sysU })).json());
  }
  const d = world("shape-why");
  d.user({ sandbox: { enabled: true, excludedCommands: ["mytool *"] }, permissions: { deny: ["Bash(docker *)"], ask: ["Bash(git push *)"], allow: ["Bash(mytool *)"] } });
  for (const command of ["docker ps", "git push origin main", "mytool run", "FOO=bar mytool run"]) docs.why.push((await run(["why", command, "--json"], d, { sys: sysU })).json());
  docs.why.push((await run(["why", "docker ps", "--json"], world("shape-why-win"), { sys: WINDOWS() })).json());
  return docs;
}

test("the JSON shapes in the README: every field of a document is named there, and every field named is in some document or marked optional", async () => {
  const start = readme.indexOf("\ncheck   {");
  assert.ok(start > 0, "the shapes are in the README");
  const block = readme.slice(start + 1, readme.indexOf("\n```", start));
  const entries = {};
  let current = null;
  for (const line of block.split("\n")) {
    const m = /^([a-z]+) +\{/.exec(line);
    if (m) { current = m[1]; entries[current] = ""; }
    if (current) entries[current] += `${line}\n`;
  }
  assert.deepEqual(Object.keys(entries), ["check", "show", "why", "lint"]);
  const docs = await documents();
  const errors = [];
  for (const command of Object.keys(entries)) {
    const shape = parseShape(entries[command].replace(/^[a-z]+ +/, ""));
    holdTo(shape, docs[command], command, errors);
  }
  assert.deepEqual(errors, []);
});

// ---- the examples are what the code prints -----------------------------------------------------------------------------------------

const tokens = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));

test("the examples in the README are what the code prints, for the projects in examples/ on Ubuntu 24.04.5 with no user settings", async () => {
  const found = [...readme.matchAll(/```text\n\$ (claude-sandbox-doctor [^\n]+)\n([\s\S]*?)\n```/g)].map((m) => ({ command: m[1], text: m[2] }));
  const shown = found.filter((b) => /^claude-sandbox-doctor (show|lint|why|check --markdown)/.test(b.command));
  assert.ok(shown.length >= 10, `${shown.length} examples of show, lint and why`);
  const w = world("readme-examples", { configDir: false }); // as on the runner: no CLAUDE_CONFIG_DIR, the config folder is ~/.claude
  const dirs = { "~/shop": copyExample(w, "shop"), "~/locked": copyExample(w, "locked") };
  const bad = [];
  for (const b of shown) {
    const args = tokens(b.command).slice(1).map((a) => dirs[a] || a);
    const r = await run(args, w, { sys: ubuntu({ profile: true }) });
    const actual = r.out
      .split(dirs["~/shop"]).join("/home/runner/shop").split(dirs["~/locked"]).join("/home/runner/locked")
      .split(w.managedDir).join("/etc/claude-code").split(w.managedDir.split(path.sep).join("/")).join("/etc/claude-code").split(w.home).join("/home/runner")
      .replace(/\/home\/runner\S*/g, (p) => p.replace(/\\/g, "/")) // paths of a Windows world have backslashes
      .trimEnd();
    // the columns of a table are as wide as its longest path, which is not the same path here: compare the words, not the spaces between them
    const squash = (t) => t.replace(/(\S) {2,}/g, "$1 ");
    if (squash(actual) !== squash(b.text)) {
      const a = squash(actual).split("\n");
      const e = squash(b.text).split("\n");
      const i = a.findIndex((l, n) => l !== e[n]);
      bad.push(`${b.command}\n  line ${i + 1}: the code prints ${JSON.stringify(a[i])}\n  the README shows ${JSON.stringify(e[i])}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("examples/shop and examples/locked are the projects the README describes", async () => {
  const w = world("readme-examples-2");
  const shop = copyExample(w, "shop");
  const lint = (await run(["lint", "--json", "--project", shop], w, { sys: ubuntu({ profile: true }) })).json();
  assert.deepEqual(lint.counts, { error: 0, warning: 9, note: 1 });
  assert.deepEqual(lint.findings.map((f) => f.id).sort(), ["bare-entry", "dead-entry", "dead-entry", "dead-entry", "domain-path", "domain-scheme", "key-scope", "protected-path", "wildcard-apex", "write-glob-linux"]);
  const locked = copyExample(w, "locked");
  assert.equal((await run(["lint", "--json", "--project", locked], w, { sys: ubuntu({ profile: true }) })).json().findings.length, 0);
  const refused = (await run(["why", "npm test", "--retry", "--json", "--project", locked], w, { sys: ubuntu({ profile: true }) })).json();
  assert.equal(refused.verdict, "refused");
});

// ---- the files ------------------------------------------------------------------------------------------------------------------------

test("the Files table of the README names every source file, and every file it names is there", () => {
  const section = readme.slice(readme.indexOf("\n## Files\n"), readme.indexOf("\n## Contributing\n"));
  assert.ok(section.length > 100, "the section is there");
  for (const f of sources()) assert.ok(section.includes(`\`${f}\``), `${f} is in the Files table`);
  for (const dir of ["skills/check/", ".claude-plugin/", "test/", "examples/", ".github/workflows/"]) assert.ok(section.includes(`\`${dir}\``), `${dir} is in the Files table`);
  for (const m of section.matchAll(/`((?:src|bin|skills|\.claude-plugin|test|examples|\.github)\/[^`\s]*)`/g)) assert.ok(exists(m[1].replace(/\/$/, "")), `${m[1]} is named in the Files table and exists`);
  for (const f of walk("test", ".mjs").filter((n) => !n.endsWith(".test.mjs"))) assert.ok(section.includes(f.slice("test/".length).replace(/\.mjs$/, "")) || section.includes(f), `${f} is named in the Files table`);
});

test("the changelog and the roadmap name what the README names: the four commands, the skill, and the good first issue", () => {
  const changelog = read("CHANGELOG.md");
  for (const word of ["check", "show", "why", "lint", "/sandbox-doctor:check", "--live", "--markdown"]) assert.ok(changelog.includes(word), `the changelog says ${word}`);
  const roadmap = read("ROADMAP.md");
  assert.match(roadmap, /https:\/\/github\.com\/nrzz\/claude-sandbox-doctor\/issues\/\d+/, "the roadmap links the good first issue");
  assert.match(read("CONTRIBUTING.md"), /good first issue/);
});
