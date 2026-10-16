// check --live: the reading of what Claude Code printed, and the whole run against a stand-in for the binary (test/fake-claude.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, put } from "./helpers.mjs";
import { findClaude, judge, readStream, runLive, scrubbedEnv, startFakeApi } from "../src/live.mjs";
import { realSys } from "../src/host.mjs";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

/** A program that runs test/fake-claude.mjs: a shell script on Linux and macOS, a .cmd file on Windows. */
function fakeClaude() {
  const dir = tmpDir("csd-fakeclaude-");
  if (process.platform === "win32") {
    const file = path.join(dir, "claude.cmd");
    fs.writeFileSync(file, `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
    return file;
  }
  const file = path.join(dir, "claude");
  put(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, 0o755);
  return file;
}
const sysWith = (situation) => ({ ...realSys({ ...process.env, FAKE_CLAUDE: situation }), env: { ...process.env, FAKE_CLAUDE: situation } });

test("judge: what each probe's result says", () => {
  const ok = (text) => ({ text, isError: false });
  assert.equal(judge("inside", ok("1\n")).outcome, "inside");
  assert.equal(judge("inside", ok("")).outcome, "outside");
  assert.equal(judge("write", ok("Exit code 1\ntouch: cannot touch '/x': Read-only file system")).outcome, "blocked");
  assert.equal(judge("write", ok("touch: /x: Operation not permitted")).outcome, "blocked");
  assert.equal(judge("write", ok(""), { fileCreated: true }).outcome, "outside");
  assert.equal(judge("write", ok("")).outcome, "unknown");
  assert.equal(judge("network", ok("403\n<sandbox_violations>\ndeny network-outbound a.invalid:80 (user denied)\n</sandbox_violations>")).evidence, "the sandbox's proxy refused it and named a.invalid:80");
  assert.equal(judge("network", ok("curl: (6) Could not resolve host: a.invalid")).outcome, "blocked");
  assert.equal(judge("network", ok("curl: not found")).outcome, "unknown");
  for (const kind of ["inside", "write", "network"]) {
    assert.equal(judge(kind, ok("Claude requested permissions to use Bash, but you haven't granted it yet.")).outcome, "refused", kind);
    assert.equal(judge(kind, ok("x"), { denied: true }).outcome, "refused", kind);
    assert.equal(judge(kind, ok("Exit code 1\nbwrap: loopback: Failed RTM_NEWADDR: Operation not permitted")).outcome, "error", kind);
    assert.equal(judge(kind, undefined).outcome, "unknown", kind);
  }
});

test("readStream: the tool results with their decisions, the result event, and the warnings on stderr", () => {
  const out = [JSON.stringify({ type: "system", subtype: "init" }), JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hi", is_error: true }] }, tool_result_meta: [{ id: "t1", permission_decision: { decision: "reject", source: "config" } }] }), "not json", JSON.stringify({ type: "result", subtype: "success", permission_denials: [{ tool_use_id: "t1" }] })].join("\n");
  const s = readStream(out, "[SandboxDebug] x\n⚠ Sandbox disabled: dependencies are missing\n  Commands will run WITHOUT sandboxing.\n");
  assert.deepEqual(s.calls, [{ id: "t1", text: "hi", isError: true, decision: { decision: "reject", source: "config" } }]);
  assert.equal(s.result.subtype, "success");
  assert.equal(s.warnings.length, 2);
  assert.match(s.warnings[0], /Sandbox disabled/);
});

test("scrubbedEnv removes the machine's CLAUDE_*, ANTHROPIC_* and CLAUDECODE variables and turns updates and telemetry off", () => {
  const e = scrubbedEnv({ PATH: "/bin", CLAUDE_CODE_X: "1", ANTHROPIC_API_KEY: "sk", CLAUDECODE: "1", AI_AGENT: "x", HOME: "/h", KEEP: "yes" }, { EXTRA: "1" });
  assert.deepEqual(Object.keys(e).filter((k) => /^(CLAUDE|ANTHROPIC|AI_AGENT)/.test(k)).sort(), ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]);
  assert.equal(e.DISABLE_AUTOUPDATER, "1");
  assert.equal(e.DISABLE_TELEMETRY, "1");
  assert.equal(e.KEEP, "yes");
  assert.equal(e.EXTRA, "1");
});

test("findClaude: the path given, else the first claude on PATH, else a message", () => {
  const dir = tmpDir("csd-find-");
  const file = path.join(dir, process.platform === "win32" ? "claude.exe" : "claude");
  put(file, "x", 0o755);
  assert.deepEqual(findClaude(file, realSys()), { path: path.resolve(file) });
  assert.match(findClaude(path.join(dir, "nope"), realSys()).error, /does not exist/);
  assert.deepEqual(findClaude(null, realSys({ PATH: dir })), { path: file });
  assert.match(findClaude(null, realSys({ PATH: path.join(dir, "empty") })).error, /claude was not found on PATH/);
});

test("the fake Messages API answers with the calls it is given, one for each turn, and then PROBE-DONE; it listens on 127.0.0.1 only", async () => {
  const api = await startFakeApi([{ command: "echo one" }, { command: "echo two" }]);
  try {
    const post = async (messages) => {
      const r = await fetch(`http://127.0.0.1:${api.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, messages }) });
      return r.text();
    };
    assert.match(await post([{ role: "user", content: "hi" }]), /"name":"Bash".*echo one/s);
    assert.match(await post([{ role: "user", content: "hi" }, { role: "assistant", content: [] }]), /echo two/);
    assert.match(await post([{ role: "assistant" }, { role: "assistant" }]), /PROBE-DONE/);
    assert.equal(api.requests.length, 3);
    const r = await fetch(`http://127.0.0.1:${api.port}/v1/other`, { method: "POST", body: "{}" });
    assert.equal(r.status, 404);
  } finally { await api.close(); }
});

const SITUATIONS = {
  healthy: { ok: true, outcomes: ["inside", "blocked", "blocked"] },
  outside: { ok: false, outcomes: ["outside", "outside", "unknown"] },
  unavailable: { ok: false, outcomes: ["outside", "refused", "refused"] },
  broken: { ok: false, outcomes: ["error", "error", "error"] },
  refuses: { ok: false, outcomes: ["error", "error", "error"] },
  silent: { ok: false, outcomes: ["unknown", "unknown", "unknown"] },
};
for (const [situation, want] of Object.entries(SITUATIONS)) {
  test(`runLive against a stand-in for claude, situation ${situation}: ${want.outcomes.join(", ")}`, async () => {
    const r = await runLive({ claude: fakeClaude(), sys: sysWith(situation), timeout: 60000 });
    assert.equal(r.version, "9.9.9 (Claude Code)");
    assert.deepEqual(r.probes.map((p) => p.outcome), want.outcomes, JSON.stringify(r.probes.map((p) => p.evidence)));
    assert.equal(r.ok, want.ok);
    assert.deepEqual(r.probes.map((p) => p.id), ["inside", "write", "network"]);
    for (const p of r.probes) assert.ok(typeof p.evidence === "string" && p.evidence.length > 0, p.id);
  });
}

test("runLive leaves nothing behind: the throwaway folder is removed, and a run that is not a sandbox says what Claude Code said on stderr", async () => {
  const before = fs.readdirSync(path.dirname(tmpDir("csd-probe-marker-"))).filter((n) => n.startsWith("csd-live-")).length;
  const r = await runLive({ claude: fakeClaude(), sys: sysWith("unavailable"), timeout: 60000 });
  assert.match(r.warnings[0], /Sandbox disabled: sandbox is enabled but dependencies are missing/);
  assert.match(r.probes[1].evidence, /did not run it without asking \(.*Sandbox disabled/);
  const after = fs.readdirSync(path.dirname(tmpDir("csd-probe-marker-"))).filter((n) => n.startsWith("csd-live-")).length;
  assert.equal(after, before, "no csd-live-* folder is left in the temp folder");
});
