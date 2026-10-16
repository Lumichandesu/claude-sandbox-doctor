// The sandbox put to the real Claude Code: what it blocks, what a connection to a host that is not allowed gets, the bubblewrap
// command it builds. Runs where the sandbox exists (Linux with bubblewrap and socat, macOS), at zero tokens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { claudeInfo, fakeApi, put, runClaude, sandbox, skip, streamEvents, toolCalls, IS_WIN } from "./claude-sandbox.mjs";

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
