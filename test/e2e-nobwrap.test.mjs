// What the real Claude Code does with `sandbox.enabled: true` on a machine where the sandbox cannot start, at zero tokens:
//   Linux without bubblewrap and socat (the CI job "ubuntu without bubblewrap and socat"),
//   Windows (run by hand: CI has no Windows job for the binary).
// failIfUnavailable false (the default): a warning, and every command runs outside the sandbox. failIfUnavailable true: Claude Code
// refuses to start. `check` and `lint` must say the same.
import test from "node:test";
import assert from "node:assert/strict";
import { claudeInfo, fakeApi, put, runClaude, sandbox, skip, streamEvents, toolCalls, resultEvent, IS_WIN } from "./claude-sandbox.mjs";
import { realSys } from "../src/host.mjs";
import { run, world } from "./helpers.mjs";

const sys = realSys();
const NO_BWRAP = process.platform === "linux" && !sys.which("bwrap") && !sys.which("socat");
const WHERE = IS_WIN ? "windows" : NO_BWRAP ? "linux-without" : null;
const SKIP = skip() || (WHERE === null && "this check is for Windows, and for Linux without bubblewrap and socat");

const TEXT = {
  windows: /sandbox is enabled but the Windows sandbox is not active on this session \(feature gate off\)/,
  "linux-without": /sandbox is enabled but dependencies are missing: bubblewrap \(bwrap\) not installed, socat not installed/,
};

async function go(settings, calls) {
  const sb = sandbox("nobwrap");
  put(sb.user, settings);
  const api = await fakeApi({ calls: calls.map((command) => ({ command })) });
  try {
    const r = await runClaude(sb, api, ["-p", "PROBE-MAIN go", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--max-turns", String(calls.length + 3)]);
    const events = streamEvents(r);
    return { r, events, calls: toolCalls(events), result: resultEvent(events), requests: api.requests.length };
  } finally { await api.close(); }
}

test("sandbox.enabled with the sandbox unavailable and failIfUnavailable off: Claude Code warns once, and the commands run outside the sandbox", { skip: SKIP, timeout: 200000 }, async (t) => {
  const a = await go({ sandbox: { enabled: true }, permissions: { allow: ["Bash"] } }, ["echo \"inside=${SANDBOX_RUNTIME:-no}\""]);
  assert.equal(a.r.code, 0, a.r.err);
  assert.match(a.r.err, /Sandbox disabled: /);
  assert.match(a.r.err, TEXT[WHERE]);
  assert.match(a.r.err, /Commands will run WITHOUT sandboxing\. Network and filesystem restrictions will NOT be enforced\./);
  assert.match(a.calls[0].text, /inside=no/, "the command ran outside the sandbox");
  // without an allow rule, a command that is not sandboxed needs approval, which `claude -p` cannot give
  const b = await go({ sandbox: { enabled: true } }, ["touch probe.txt"]);
  assert.ok(b.result.permission_denials.length === 1, "the call was refused: nothing sandboxed it, so autoAllowBashIfSandboxed did not approve it");
  t.diagnostic(`Claude Code ${claudeInfo().version} on ${WHERE}: ${a.r.err.split("\n").filter(Boolean).slice(0, 2).join(" | ").slice(0, 300)}`);
});

test("sandbox.enabled with failIfUnavailable on: Claude Code refuses to start, sends no request, and says why", { skip: SKIP, timeout: 200000 }, async (t) => {
  const g = await go({ sandbox: { enabled: true, failIfUnavailable: true }, permissions: { allow: ["Bash"] } }, ["echo hi"]);
  assert.equal(g.r.code, 1);
  assert.equal(g.requests, 0, "no request reached the model");
  assert.match(g.r.err, /Error: sandbox required but unavailable: /);
  assert.match(g.r.err, TEXT[WHERE]);
  assert.match(g.r.err, /sandbox\.failIfUnavailable is set/);
  assert.equal(g.result.subtype, "error_during_execution");
  assert.match(g.result.errors[0], /^Sandbox required but unavailable: /);
  t.diagnostic(`Claude Code ${claudeInfo().version} on ${WHERE}: ${String(g.result.errors[0]).slice(0, 260)}`);
});

test("check and lint say the same: the dependencies that are missing, and a failIfUnavailable that stops Claude Code", { skip: SKIP }, async () => {
  const w = world("nobwrap-check");
  w.user({ sandbox: { enabled: true, failIfUnavailable: true } });
  const c = await run(["check", "--json"], w);
  const model = c.json();
  if (WHERE === "windows") {
    assert.equal(c.code, 0, "no Bash sandbox on Windows is not a failure");
    assert.equal(model.hasSandbox, false);
  } else {
    assert.equal(c.code, 1);
    assert.deepEqual(model.missing, ["bwrap", "socat"]);
  }
  const l = await run(["lint", "--json"], w);
  const f = l.json().findings.find((x) => x.id === "fail-if-unavailable");
  assert.ok(f, "lint names failIfUnavailable");
  assert.equal(f.severity, "error");
  assert.equal(l.code, 1);
});
