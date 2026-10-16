// The sandbox put to the real Claude Code: what it blocks, what a connection to a host that is not allowed gets, the bubblewrap
// command it builds. Runs where the sandbox exists (Linux with bubblewrap and socat, macOS), at zero tokens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE, claudeInfo, fakeApi, put, runClaude, sandbox, skip, streamEvents, toolCalls, IS_WIN } from "./claude-sandbox.mjs";
import { runSession } from "./oracle.mjs";
import { runCli, world } from "./helpers.mjs";

const SKIP = skip() || (IS_WIN && "the Bash sandbox exists on Linux, WSL2 and macOS only");
const LINUX = process.platform === "linux";

/** One session: the settings, the calls, and what came back for each. */
async function session(label, settings, commands, { env = {}, allowBash = false } = {}) {
  const sb = sandbox(label);
  const user = { ...settings, ...(allowBash ? { permissions: { allow: ["Bash"] } } : {}) };
  put(sb.user, user);
  const api = await fakeApi({ calls: commands.map((c) => (typeof c === "string" ? { command: c } : c)) });
  try {
    const run = await runClaude(sb, api, ["-p", "PROBE-MAIN go", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--max-turns", String(commands.length + 3)], { env });
    const events = streamEvents(run);
    return { sb, run, events, calls: toolCalls(events), api };
  } finally {
    await api.close();
  }
}

test("a write outside the project is blocked inside the sandbox, a call taken out of it by excludedCommands writes, and the transcript says which", { skip: SKIP, timeout: 300000 }, async (t) => {
  const sb0 = sandbox("probe-write");
  const target = path.join(sb0.home, "outside-write");
  const inside = await session("write-in", { sandbox: { enabled: true } }, [`touch ${JSON.stringify(target)}`, "printenv SANDBOX_RUNTIME"]);
  assert.equal(fs.existsSync(target), false, "the sandbox kept the write out");
  const [write, env] = inside.calls;
  assert.match(write.text, LINUX ? /Read-only file system/ : /Operation not permitted/);
  assert.equal(write.isError, true);
  assert.match(env.text, /^1\s*$/m, "SANDBOX_RUNTIME=1 for a command inside the sandbox");
  const out = await session("write-out", { sandbox: { enabled: true, excludedCommands: ["touch *"] } }, [`touch ${JSON.stringify(path.join(sb0.home, "outside-write-2"))}`], { allowBash: true });
  assert.equal(fs.existsSync(path.join(sb0.home, "outside-write-2")), true, "the excluded call ran outside the sandbox and wrote");
  t.diagnostic(`Claude Code ${claudeInfo().version}: write outside -> ${JSON.stringify(write.text.split("\n")[1] || write.text).slice(0, 140)}`);
  void out;
});

const curl = (host) => `curl -sS -m 10 -o /dev/null -w "%{http_code}" http://${host}/`;

test("a connection to a host that is not in allowedDomains is refused by the sandbox's proxy and the result names the host; with the host in allowedDomains the proxy lets it through; in bypassPermissions mode it lets every host through", { skip: SKIP, timeout: 300000 }, async (t) => {
  const run = (label, mode, network) => runSession({ label, mode, user: { sandbox: { enabled: true, ...(network ? { network } : {}) } }, project: {}, programs: [], commands: [curl("probe-a.invalid")] });
  const closed = await run("net-closed", "default");
  const open = await run("net-open", "default", { allowedDomains: ["probe-a.invalid"] });
  const bypass = await run("net-bypass", "bypassPermissions");
  const bypassManaged = await run("net-bypass-denied", "bypassPermissions", { deniedDomains: ["probe-a.invalid"] });
  const strictUser = await run("net-strict-user", "bypassPermissions", { strictAllowlist: true });
  const strictProject = await runSession({ label: "net-strict-project", mode: "bypassPermissions", user: { sandbox: { enabled: true } }, project: { sandbox: { network: { strictAllowlist: true } } }, programs: [], commands: [curl("probe-a.invalid")] });
  const refused = closed.calls[0].text;
  assert.ok(refused.includes("403"), refused);
  assert.ok(refused.includes("network-outbound probe-a.invalid:80"), refused);
  assert.ok(!open.calls[0].text.includes("403"), open.calls[0].text);
  assert.ok(!open.calls[0].text.includes("network-outbound"), open.calls[0].text);
  assert.ok(!bypass.calls[0].text.includes("403"), `bypassPermissions: ${bypass.calls[0].text}`);
  assert.ok(bypassManaged.calls[0].text.includes("403"), `a deniedDomains entry holds in bypassPermissions: ${bypassManaged.calls[0].text}`);
  assert.ok(strictUser.calls[0].text.includes("403"), `strictAllowlist in a user file holds in bypassPermissions: ${strictUser.calls[0].text}`);
  assert.ok(!strictProject.calls[0].text.includes("403"), `strictAllowlist in a project file does nothing: ${strictProject.calls[0].text}`);
  const one = (r) => JSON.stringify(r.calls[0].text.replace(/\s+/g, " ").slice(0, 120));
  t.diagnostic(`Claude Code ${claudeInfo().version}: default mode, host not listed -> ${one(closed)}; listed -> ${one(open)}; bypassPermissions, host not listed -> ${one(bypass)}; denied -> ${one(bypassManaged)}; strictAllowlist in the user file -> ${one(strictUser)}; in the project file -> ${one(strictProject)}`);
});

test("check agrees with the binary: the sandbox can start here, and check --live finds the command inside the sandbox, the write blocked and the connection refused", { skip: SKIP, timeout: 300000 }, async (t) => {
  const w = world("check-live");
  const plain = runCli(["check", "--json"], { cwd: w.work, env: w.env });
  assert.equal(plain.code, 0, plain.all);
  assert.equal(JSON.parse(plain.out).ok, true);
  const live = runCli(["check", "--live", "--json", "--claude", CLAUDE], { cwd: w.work, env: w.env, timeout: 280000 });
  assert.equal(live.code, 0, live.all);
  const j = JSON.parse(live.out);
  assert.equal(j.live.skipped, false);
  assert.deepEqual(j.live.probes.map((p) => `${p.id}:${p.outcome}`), ["inside:inside", "write:blocked", "network:blocked"]);
  assert.equal(j.live.ok, true);
  assert.match(j.live.version, /Claude Code/);
  t.diagnostic(`check --live on ${process.platform} with ${j.live.version}: ${j.live.probes.map((p) => `${p.id} ${p.outcome} (${p.evidence})`).join("; ")}`);
});
