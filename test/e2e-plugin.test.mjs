// Checks against the real Claude Code binary (run only when E2E_CLAUDE points at one) about the plugin:
//   it validates, also with --strict;
//   the user-only skill adds nothing to a request that does not use it;
//   /sandbox-doctor:check hands the model the lint report for the project and the check of the machine, whichever way Claude Code
//   runs the command lines, and what it costs is measured (the README's "What it costs in tokens");
//   a skill whose command exits 1 never reaches the model, which is why `lint --markdown` and `check --markdown` always exit 0;
//   the skill's allowed-tools let the model run the commands with no prompt;
//   the plugin's own cost projection (claude plugin details) is small.
// The fake API on 127.0.0.1 answers; no token is spent, and every run has its own throwaway HOME, USERPROFILE and CLAUDE_CONFIG_DIR.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import { claudeInfo, fakeApi, put, runClaude, sandbox, skip, textBlocks, userText, claudeNoApi, IS_WIN } from "./claude-sandbox.mjs";

const fwd = (p) => p.replace(/\\/g, "/");
const main = (api) => api.requests.find((r) => userText(r).includes("PROBE-MAIN")) || api.requests[0];
// the request that carries a skill's text (a version may send other requests too, for a title or a quota check)
const withSkill = (api) => api.requests.find((r) => textBlocks(r).some((b) => b.startsWith("Base directory for this skill")));
const skillBlock = (api) => textBlocks(withSkill(api) || main(api)).find((b) => b.startsWith("Base directory for this skill"));

/** A project with something to say: a bare entry, an entry that never matches, a domain with a scheme. */
function project(sb) {
  put(sb.project, { sandbox: { enabled: true, excludedCommands: ["docker", "sudo *"], network: { allowedDomains: ["https://github.com"] } } });
}

test("claude plugin validate accepts the plugin, also with --strict", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("validate");
  for (const args of [["plugin", "validate", ROOT], ["plugin", "validate", ROOT, "--strict"], ["plugin", "validate", path.join(ROOT, ".claude-plugin", "plugin.json"), "--strict"]]) {
    const r = await claudeNoApi(sb, args);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Validation passed/);
  }
});

test("the user-only skill adds nothing to a request that does not use it: no tool, no skill list entry, no word of it", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("always");
  const without = await fakeApi();
  const withPlugin = await fakeApi();
  try {
    await runClaude(sb, without, ["-p", "PROBE-MAIN hello", "--output-format", "json"]);
    await runClaude(sb, withPlugin, ["-p", "PROBE-MAIN hello", "--plugin-dir", ROOT, "--output-format", "json"]);
    // the two runs are the same but for the ids and the times that every request carries
    const plain = (r) => JSON.stringify(r).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g, "<time>");
    const a = plain(main(without));
    const b = plain(main(withPlugin));
    assert.ok(!b.includes("sandbox-doctor"), "nothing of the plugin is in the request");
    assert.ok(!b.includes("Check the sandbox"), "not even the skill's description");
    assert.equal(JSON.stringify(main(withPlugin).tools), JSON.stringify(main(without).tools), "the tool list is the same");
    assert.equal(b.length, a.length, "the request has the same size with the plugin loaded");
    t.diagnostic(`plain prompt: ${a.length} characters without the plugin, ${b.length} with it; the string sandbox-doctor appears ${b.split("sandbox-doctor").length - 1} times`);
  } finally { await without.close(); await withPlugin.close(); }
});

test("/sandbox-doctor:check hands the model the lint report for the project and the check of the machine, whichever way Claude Code runs the command lines, and what it costs is measured", { skip: skip(), timeout: 240000 }, async (t) => {
  const sb = sandbox("skill");
  project(sb);
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", "/sandbox-doctor:check", "--plugin-dir", ROOT, "--output-format", "json"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(withSkill(api), "the skill reached the model");
    const blocks = textBlocks(withSkill(api));
    const skillText = skillBlock(api);
    assert.ok(skillText, `the skill text is in the request:\n${blocks.map((b) => b.slice(0, 80)).join("\n")}`);
    const commandText = blocks.find((b) => b.includes("<command-name>/sandbox-doctor:check</command-name>"));
    // Claude Code hands the model each ! line in one of two forms: its output pasted in its place, or an instruction to run it
    if (/run this first/.test(skillText)) {
      assert.ok(skillText.includes(`bin/claude-sandbox-doctor.mjs" lint --project "${fwd(sb.work)}" --markdown`), `the lint command, with the plugin folder and the project folder filled in:\n${skillText}`);
      assert.ok(skillText.includes('bin/claude-sandbox-doctor.mjs" check --markdown'), "the check command");
    } else {
      assert.match(skillText, new RegExp(`## sandbox-doctor lint: ${sb.work.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
      assert.match(skillText, /`bare-entry`/);
      assert.match(skillText, /`dead-entry`/);
      assert.match(skillText, /`domain-scheme`/);
      assert.match(skillText, /## sandbox-doctor check: /);
    }
    assert.match(skillText, /At most 10 lines: whether the sandbox can work on this machine, and each setting that can never take effect with its file and the fix\./);
    assert.match(skillText, /Edit nothing until the user agrees\./);
    assert.ok(!skillText.includes("${CLAUDE_"), "no variable is left unexpanded");
    const chars = skillText.length + (commandText ? commandText.length : 0);
    t.diagnostic(`/sandbox-doctor:check on a project with 3 findings on ${process.platform}: ${skillText.length} characters in the skill block${commandText ? ` and ${commandText.length} in the command block` : ""}, about ${Math.round(chars / 4)} tokens by characters / 4 (the project path is ${sb.work.length} characters of it)`);
    assert.ok(chars < 4500, `${chars} characters`);
  } finally { await api.close(); }
});

test("the worst report the skill can hand over is capped (12 findings, 300 characters a line), and its size is measured", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("skill-worst");
  const many = Array.from({ length: 30 }, (_, i) => `docker-${"averyveryverylongname".repeat(8)}-${i}`);
  put(sb.project, { sandbox: { enabled: true, excludedCommands: many, network: { allowedDomains: many.map((d) => `https://${d}.example.com/path`) } } });
  const api = await fakeApi();
  try {
    await runClaude(sb, api, ["-p", "/sandbox-doctor:check", "--plugin-dir", ROOT, "--output-format", "json"]);
    const skillText = skillBlock(api);
    assert.ok(skillText);
    if (/run this first/.test(skillText)) return;
    const report = skillText.slice(skillText.indexOf("## sandbox-doctor lint"), skillText.indexOf("## sandbox-doctor check"));
    const lines = report.trim().split("\n");
    const commandText = textBlocks(withSkill(api) || main(api)).find((b) => b.includes("<command-name>/sandbox-doctor:check</command-name>"));
    const chars = skillText.length + (commandText ? commandText.length : 0);
    t.diagnostic(`worst case built here: ${skillText.length} characters in the skill block${commandText ? ` and ${commandText.length} in the command block` : ""}, ${lines.length} lines of lint report, about ${Math.round(chars / 4)} tokens by characters / 4`);
    assert.ok(lines.length <= 15, `${lines.length} lines`);
    for (const l of lines) assert.ok(l.length <= 300, `${l.length} characters in a line`);
    assert.ok(skillText.length < 7500, `${skillText.length} characters`);
  } finally { await api.close(); }
});

test("a skill whose command line exits 1 never reaches the model, and the same skill with --markdown does: why lint --markdown always exits 0", { skip: skip(), timeout: 300000 }, async (t) => {
  const seen = {};
  for (const [variant, flag] of [["without --markdown", ""], ["with --markdown", " --markdown"]]) {
    const sb = sandbox("failskill");
    project(sb);
    // a copy of the skill whose command is `lint` as it is (exit 1 when there is a warning) or `lint --markdown`
    const plug = path.join(sb.root, "plug");
    fs.mkdirSync(path.join(plug, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(plug, "skills", "check"), { recursive: true });
    fs.writeFileSync(path.join(plug, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "csd-fail", version: "1.0.0", description: "a copy of the skill that runs lint with or without --markdown" }));
    const line = `node "${fwd(ROOT)}/bin/claude-sandbox-doctor.mjs" lint --project "\${CLAUDE_PROJECT_DIR}"${flag}`;
    fs.writeFileSync(path.join(plug, "skills", "check", "SKILL.md"), ["---", "name: check", "description: Check the sandbox.", "disable-model-invocation: true", "allowed-tools: Bash(node *) PowerShell(node *)", "---", "", `!\`${line}\``, "", "At most 10 lines: say what is wrong.", ""].join("\n"));
    const api = await fakeApi();
    try {
      const r = await runClaude(sb, api, ["-p", "/csd-fail:check", "--plugin-dir", plug, "--output-format", "json", "--permission-mode", "default"]);
      assert.equal(r.code, 0, r.err);
      seen[variant] = { requests: api.requests.length, reached: Boolean(withSkill(api)) };
    } finally { await api.close(); }
  }
  t.diagnostic(`a skill whose command exits 1: ${seen["without --markdown"].requests} requests reached the model; with --markdown: ${seen["with --markdown"].requests}`);
  assert.equal(seen["with --markdown"].reached, true, "the report reaches the model");
  assert.equal(seen["without --markdown"].reached, false, "a command that exits 1 drops the skill");
});

test("the skill's allowed-tools let the model run the commands with no prompt (permission mode default): the Bash tool, and on Windows the PowerShell tool", { skip: skip(), timeout: 240000 }, async () => {
  for (const [tool, env] of [["Bash", {}], ...(IS_WIN ? [["PowerShell", { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CLAUDE_CODE_GIT_BASH_PATH: "C:/nonexistent/bash.exe" }]] : [])]) {
    const sb = sandbox(`allowed-${tool}`);
    project(sb);
    const command = `node "${fwd(ROOT)}/bin/claude-sandbox-doctor.mjs" lint --project "${fwd(sb.work)}" --markdown`;
    const api = await fakeApi({ calls: [{ tool, command, description: "Run the lint" }] });
    try {
      const r = await runClaude(sb, api, ["-p", "/sandbox-doctor:check", "--plugin-dir", ROOT, "--output-format", "json", "--permission-mode", "default", "--max-turns", "3"], { env });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(r.result.permission_denials, [], `${tool}: nothing was refused`);
      const seen = new Map();
      for (const b of api.requests.flatMap((rq) => rq.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))) if (b.type === "tool_result") seen.set(b.tool_use_id, b);
      const results = [...seen.values()];
      assert.equal(results.length, 1, `${tool}: the command ran`);
      assert.match(JSON.stringify(results[0].content), /## sandbox-doctor lint/, `${tool}: and printed the report`);
    } finally { await api.close(); }
  }
});

test("installed from a marketplace, the plugin's own cost projection is small and its skill is one user-only skill", { skip: skip(), timeout: 300000 }, async (t) => {
  const sb = sandbox("details");
  const mkt = path.join(sb.root, "mkt");
  const dest = path.join(mkt, "plugins", "sandbox-doctor");
  fs.mkdirSync(path.join(mkt, ".claude-plugin"), { recursive: true });
  for (const item of ["bin", "src", "skills", ".claude-plugin", "package.json"]) fs.cpSync(path.join(ROOT, item), path.join(dest, item), { recursive: true });
  fs.writeFileSync(path.join(mkt, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "local-test", owner: { name: "test" }, plugins: [{ name: "sandbox-doctor", description: "x", source: "./plugins/sandbox-doctor" }] }));
  const claude = (...args) => runClaude(sb, null, args, { timeout: 100000 });
  const added = await claude("plugin", "marketplace", "add", mkt);
  assert.equal(added.code, 0, added.out + added.err);
  const installed = await claude("plugin", "install", "sandbox-doctor@local-test");
  assert.equal(installed.code, 0, installed.out + installed.err);
  const details = await claude("plugin", "details", "sandbox-doctor");
  assert.equal(details.code, 0, details.out + details.err);
  assert.match(details.out, /Skills \(1\)\s+check/);
  assert.match(details.out, /Hooks \(0\)/);
  const always = /Always-on:\s+~(\d+) tok/.exec(details.out);
  assert.ok(always && Number(always[1]) < 30, `always-on is ${always && always[1]} tokens`);
  const row = /^\s*check\s+.*$/m.exec(details.out);
  t.diagnostic(`claude plugin details on ${claudeInfo().version}: ${always[0].replace(/\s+/g, " ")}; per component: ${row ? row[0].trim().replace(/\s+/g, " ") : "(no row)"}`);
});
