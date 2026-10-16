// `why`: the model (where the call runs, the entry that matched, the reasons, the retry, the approval) and its text, through the CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { run, world } from "./helpers.mjs";
import { loadSettings } from "../src/settings.mjs";
import { bashRules, whyCommand } from "../src/why.mjs";

const why = (w, command, extra = {}, platform = "linux") => whyCommand({ command, settings: loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, platform: "linux" }), platform, ...extra });

test("a call that every part of is covered runs outside the sandbox, and the model names the entry and its file for each part", () => {
  const w = world("why-out");
  w.user({ sandbox: { enabled: true, excludedCommands: ["docker *"] } });
  w.project({ sandbox: { excludedCommands: ["gh pr *"] } });
  const r = why(w, "docker compose up -d && gh pr list");
  assert.equal(r.verdict, "unsandboxed");
  assert.equal(r.basis, "excluded");
  assert.deepEqual(r.excludedBy.map((x) => [x.part, x.entry, x.source.scope]), [["docker compose up -d", "docker *", "user"], ["gh pr list", "gh pr *", "project"]]);
  assert.equal(r.approval.how, "regular");
  assert.equal(r.approval.outcome, "asked");
});

test("a call with a part that no entry covers stays inside, and says which part and why", () => {
  const w = world("why-in");
  w.user({ sandbox: { enabled: true, excludedCommands: ["docker *"] } });
  const r = why(w, "cd sub && docker build .");
  assert.equal(r.verdict, "sandboxed");
  assert.equal(r.basis, "no-match");
  assert.deepEqual(r.parts.map((p) => [p.text, p.covered, p.reasons.map((x) => x.code)]), [["cd sub", false, ["directory"]], ["docker build .", true, []]]);
  assert.equal(r.approval.how, "auto-allow");
  assert.equal(r.approval.outcome, "approved");
});

test("a redirection keeps the whole call in the sandbox, whatever the entries say", () => {
  const w = world("why-redirect");
  w.user({ sandbox: { enabled: true, excludedCommands: ["gh *"] } });
  const r = why(w, "gh api user > out.json");
  assert.equal(r.verdict, "sandboxed");
  assert.equal(r.basis, "shape");
  assert.deepEqual(r.callReasons.map((x) => x.code), ["redirect"]);
  assert.equal(why(w, "gh api user 2>&1").verdict, "unsandboxed");
});

test("the retry: dangerouslyDisableSandbox is honored, or refused when allowUnsandboxedCommands is false", () => {
  const w = world("why-retry");
  w.user({ sandbox: { enabled: true, excludedCommands: ["docker *"] } });
  assert.equal(why(w, "gh pr list", { retry: true }).verdict, "unsandboxed");
  assert.equal(why(w, "gh pr list", { retry: true }).basis, "retry-allowed");
  w.user({ sandbox: { enabled: true, excludedCommands: ["docker *"], allowUnsandboxedCommands: false } });
  const refused = why(w, "gh pr list", { retry: true });
  assert.equal(refused.verdict, "refused");
  assert.equal(refused.basis, "retry-refused");
  assert.equal(refused.runs, "sandboxed");
  assert.match(refused.reason, /allowUnsandboxedCommands is false/);
  assert.equal(why(w, "docker ps", { retry: true }).verdict, "unsandboxed", "a call an entry excludes needs no retry");
  assert.equal(why(w, "docker ps", { retry: true }).basis, "excluded");
});

test("a sandbox that is off runs everything outside, and says why: no enabled, or enabledPlatforms in managed settings", () => {
  const a = world("why-off");
  a.user({ sandbox: { excludedCommands: ["docker *"] } });
  const r = why(a, "docker ps");
  assert.equal(r.basis, "sandbox-off");
  assert.match(r.reason, /sandbox\.enabled is not true/);
  const b = world("why-platform");
  b.user({ sandbox: { enabled: true } });
  b.managed({ sandbox: { enabledPlatforms: ["macos"] } });
  assert.match(why(b, "docker ps").reason, /enabledPlatforms/);
  assert.equal(why(b, "docker ps", {}, "macos").basis, "no-entries");
});

test("approval: auto-allow, the shapes that still go through the regular flow, deny, ask and allow rules", () => {
  const w = world("why-approval");
  w.user({ sandbox: { enabled: true, excludedCommands: ["gh *"] }, permissions: { deny: ["Bash(rm *)"], ask: ["Bash(git push *)"], allow: ["Bash(gh pr *)"] } });
  const ap = (c) => why(w, c).approval;
  assert.equal(ap("mytool run").how, "auto-allow");
  assert.equal(ap("FOO=bar mytool run").how, "regular");
  assert.match(ap("FOO=bar mytool run").text, /FOO=\.\.\./);
  assert.equal(ap("make CC=clang").how, "regular");
  assert.equal(ap("eval \"ls\"").how, "regular");
  assert.equal(ap("rm -rf x").how, "denied");
  assert.equal(ap("git push origin main").how, "ask");
  assert.equal(ap("gh pr list").how, "allow-rule");
  assert.equal(ap("gh pr list").outcome, "approved");
  assert.equal(ap("gh issue list").how, "regular");
  const off = world("why-noauto");
  off.user({ sandbox: { enabled: true, autoAllowBashIfSandboxed: false } });
  assert.equal(why(off, "mytool run").approval.how, "regular");
  assert.match(why(off, "mytool run").approval.text, /autoAllowBashIfSandboxed is false/);
  const bare = world("why-bare");
  bare.user({ sandbox: { enabled: true, excludedCommands: ["gh *"] }, permissions: { ask: ["Bash"] } });
  assert.equal(why(bare, "mytool run").approval.how, "auto-allow", "a bare Bash ask rule is skipped for a sandboxed call");
  assert.equal(why(bare, "gh pr list").approval.how, "ask", "and applies to one that runs outside");
});

test("bashRules: an allow rule per part must cover every part; the bare Bash allows all", () => {
  const w = world("why-rules");
  w.user({ permissions: { allow: ["Bash(git status)", "Bash(npm test)"] } });
  const s = loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, platform: "linux" });
  assert.ok(bashRules("git status && npm test", s).allow);
  assert.equal(bashRules("git status && npm publish", s).allow, null);
  w.user({ permissions: { allow: ["Bash"] } });
  assert.ok(bashRules("anything at all", loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, platform: "linux" })).allow);
});

test("why through the command line: text, JSON, --retry, exit codes", async () => {
  const w = world("why-cli");
  w.user({ sandbox: { enabled: true, excludedCommands: ["docker *"], allowUnsandboxedCommands: false } });
  const text = await run(["why", "docker ps && docker images"], w, { platform: "linux" });
  assert.equal(text.code, 0);
  assert.match(text.out, /outside the sandbox/);
  assert.match(text.out, /matches "docker \*"/);
  const stays = await run(["why", "docker ps > out.txt"], w);
  assert.equal(stays.code, 0);
  assert.match(stays.out, /inside the sandbox/);
  assert.match(stays.out, /a redirection to or from a file/);
  const refused = await run(["why", "gh pr list", "--retry"], w);
  assert.equal(refused.code, 1, "refused exits 1");
  assert.match(refused.out, /refused/);
  const j = (await run(["why", "docker ps", "--json"], w)).json();
  assert.equal(j.verdict, "unsandboxed");
  assert.equal(j.ok, true);
  assert.equal(j.excludedBy[0].entry, "docker *");
  assert.equal(j.strict, true);
  assert.equal((await run(["why"], w)).code, 2);
  assert.equal((await run(["why", "a", "b"], w)).code, 2);
  assert.equal((await run(["why", "  "], w)).code, 2);
  const d = world("why-deny");
  d.user({ sandbox: { enabled: true }, permissions: { deny: ["Bash(docker *)"] } });
  assert.equal((await run(["why", "docker ps"], d)).code, 1, "a call that a deny rule refuses exits 1");
});

test("on a machine with no Bash sandbox, the answer is for Linux, macOS and WSL2, and says so", async () => {
  const w = world("why-win");
  w.user({ sandbox: { enabled: true, excludedCommands: ["docker *"] } });
  const { WINDOWS } = await import("./fakesys.mjs");
  const r = await run(["why", "docker ps > x"], w, { sys: WINDOWS() });
  assert.match(r.out, /no Bash sandbox \(Windows\)/);
  assert.match(r.out, /inside the sandbox/);
});
