// Running the real claude binary at zero cost, for the checks that need it (test/e2e-*.test.mjs).
//
// A check runs only when E2E_CLAUDE names a Claude Code binary ("claude" on a CI machine after
// `npm install -g @anthropic-ai/claude-code`, or the full path to claude.exe). Otherwise it is skipped, and `npm test` needs
// nothing but Node. The binary runs in a throwaway folder with its own config folder and home, with an environment scrubbed of
// every CLAUDE_* and ANTHROPIC_* variable of the machine, and with ANTHROPIC_BASE_URL pointing at a tiny server on 127.0.0.1 that
// answers from a script. No request leaves the machine, no token is spent, no login is needed. The binary is started with spawn
// (asynchronous) and with stdin ignored: a spawnSync would block the event loop that the fake server lives in, and `-p` waits for
// input on an open stdin.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpDir, fwd } from "./helpers.mjs";

export const CLAUDE = process.env.E2E_CLAUDE || "";
export const IS_WIN = process.platform === "win32";
const USAGE = { input_tokens: 1, output_tokens: 1 };
const viaShell = () => IS_WIN && !/\.exe$/i.test(CLAUDE);

/** A scrubbed environment: none of the machine's CLAUDE_* and ANTHROPIC_* variables, no updates, no telemetry. */
export function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|CLAUDECODE|AI_AGENT|MCP_|ENABLE_TOOL_SEARCH|SANDBOX_RUNTIME)/i.test(k)) env[k] = v;
  return { ...env, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_COLOR: "1", ...bashEnv(), ...extra };
}

/** { ok, version, number, reason }: whether E2E_CLAUDE names a binary that runs, and the version it prints. Asked once, when this file loads. */
function probeBinary() {
  if (!CLAUDE) return Promise.resolve({ ok: false, version: "", number: "", reason: "E2E_CLAUDE is not set (point it at a claude binary to run the checks against the real thing)" });
  const home = tmpDir("csd-e2e-probe-");
  return new Promise((resolve) => {
    // like every other start of the binary: spawn (asynchronous), standard input ignored, a config folder of its own
    // a file that is no program (a wrapper left by an install that failed) makes spawn throw at once, with ENOEXEC
    let child;
    try { child = spawn(CLAUDE, ["--version"], { windowsHide: true, shell: viaShell(), stdio: ["ignore", "pipe", "pipe"], env: baseEnv({ CLAUDE_CONFIG_DIR: path.join(home, ".claude"), HOME: home, USERPROFILE: home }) }); } catch (e) { resolve({ ok: false, version: "", number: "", reason: `E2E_CLAUDE (${CLAUDE}) did not run: ${e.message}` }); return; }
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, version: "", number: "", reason: `E2E_CLAUDE (${CLAUDE}) did not run: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = out.trim();
      resolve(code === 0 && version ? { ok: true, version, number: (/\d+\.\d+\.\d+/.exec(version) || [""])[0], reason: "" } : { ok: false, version: "", number: "", reason: `E2E_CLAUDE (${CLAUDE}) did not run: ${err.trim().slice(0, 120)}` });
    });
  });
}
const info = await probeBinary();
export const claudeInfo = () => info;
/** The value for node:test's `skip` option: false when the binary is there, else the reason. */
export const skip = () => (claudeInfo().ok ? false : claudeInfo().reason);
/** The version as numbers [2, 1, 299], for the checks that differ between versions. */
export const versionNumbers = () => ((/(\d+)\.(\d+)\.(\d+)/.exec(claudeInfo().version) || [0, 0, 0, 0]).slice(1).map(Number));
export const atLeast = (a, b, c) => { const [x, y, z] = versionNumbers(); return x !== a ? x > a : y !== b ? y > b : z >= c; };

/** Git Bash on Windows, so the Bash tool exists; nothing on the other systems. */
function bashEnv() {
  if (!IS_WIN) return {};
  const candidates = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  const where = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
  for (const line of (where.stdout || "").split(/\r?\n/).filter(Boolean)) candidates.push(path.join(path.dirname(line), "..", "bin", "bash.exe"));
  candidates.push("C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe");
  for (const c of candidates) if (c && fs.existsSync(c)) return { CLAUDE_CODE_USE_POWERSHELL_TOOL: "0", CLAUDE_CODE_GIT_BASH_PATH: path.resolve(c).replace(/\\/g, "/") };
  return {};
}

/**
 * A throwaway world for the binary: home, a config folder (CLAUDE_CONFIG_DIR) and a project folder that Claude Code already trusts.
 *   cfg/settings.json                 the user's settings
 *   work/.claude/settings.json        the project's settings
 *   work/.claude/settings.local.json  the local settings
 *   bin/                              programs that come first on the PATH of a run (see shims)
 *   marks                             the file the shims append to
 */
export function sandbox(label) {
  const root = tmpDir(`csd-e2e-${label}-`);
  const home = path.join(root, "home");
  const cfg = path.join(root, "cfg");
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  for (const d of [home, cfg, work, bin]) fs.mkdirSync(d, { recursive: true });
  const trust = { hasTrustDialogAccepted: true, allowedTools: [] };
  fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [work]: trust, [fwd(work)]: trust } }, null, 2));
  return {
    root, home, cfg, work, bin,
    marks: path.join(work, ".csd-marks"),
    user: path.join(cfg, "settings.json"),
    project: path.join(work, ".claude", "settings.json"),
    local: path.join(work, ".claude", "settings.local.json"),
    env: { CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home },
  };
}

/** Write a file: an object as JSON, a string as it is. */
export function put(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  return file;
}

/**
 * Programs that stand in for the real ones on the PATH of a run. Each appends a line "<name> <1 or 0>" to the file $CSD_MARKS: 1
 * when SANDBOX_RUNTIME is set (Claude Code sets it for a command it runs in the sandbox), else 0. They print nothing and exit 0,
 * so a table of calls can tell, for each call, whether it ran inside the sandbox or outside it, whatever the call looks like.
 */
export function shims(sb, names) {
  for (const name of names) put(path.join(sb.bin, name), ["#!/bin/sh", 'if [ -n "$SANDBOX_RUNTIME" ]; then s=1; else s=0; fi', `printf '%s %s\\n' "${name}" "$s" >> "$CSD_MARKS"`, "exit 0", ""].join("\n"), 0o755);
}

const msgStart = (id, model) => ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: model || "x", content: [], stop_reason: null, usage: USAGE } }];

/** SSE events for an assistant message with the given blocks: { text } or { tool, input, id }. */
export function message(id, model, blocks) {
  const ev = [msgStart(id, model)];
  blocks.forEach((b, i) => {
    if (b.text !== undefined) {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } }]);
    } else {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id || `toolu_${id}_${i}`, name: b.tool, input: {} } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  });
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: blocks.some((b) => b.tool) ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }]);
  ev.push(["message_stop", { type: "message_stop" }]);
  return ev;
}

/** All the text the user side of a request holds (the prompt, expanded skills, tool results). */
export const userText = (j) => (j.messages || []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content || []).map((b) => b.text || "").join(""))).join("\n");
/** Every text block of a request's messages. */
export const textBlocks = (request) => (request.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content])).map((b) => (typeof b === "string" ? b : (b && b.text) || ""));

/**
 * The fake Messages API. Every request is recorded in `requests`, whole.
 *   calls    the Bash calls of the conversation, one for each turn: { command, dangerouslyDisableSandbox?, description? }
 *   before   (turn) => void, called just before call number `turn` is sent (a table of calls writes its row marker here)
 * After the last call the answer is "PROBE-DONE". A request that is not the conversation (stream false) gets "done".
 */
export function fakeApi({ calls = [], before } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!req.url.includes("/v1/messages")) { res.writeHead(404); res.end("{}"); return; }
      let j = {};
      try { j = JSON.parse(body); } catch { /* empty */ }
      requests.push(j);
      const n = requests.length;
      if (j.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_${n}`, type: "message", role: "assistant", model: j.model || "x", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: USAGE }));
        return;
      }
      const turn = (j.messages || []).filter((m) => m.role === "assistant").length;
      const step = calls[turn];
      let events;
      if (step) {
        if (before) before(turn);
        const input = { command: step.command, description: step.description || `call ${turn}`, ...(step.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: step.dangerouslyDisableSandbox } : {}), ...(step.input || {}) };
        events = message(`msg_${n}`, j.model, [{ tool: step.tool || "Bash", id: `toolu_call_${turn}`, input }]);
      } else events = message(`msg_${n}`, j.model, [{ text: "PROBE-DONE" }]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { server.unref(); resolve({ port: server.address().port, requests, close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }) }); }));
}

function killTree(child) {
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}

/**
 * Run claude in the sandbox's project folder. Resolves { code, out, err, result, ms } (result: the --output-format json document).
 * `api` is the fake API the binary talks to; null for a command that needs none (claude plugin validate).
 *   path   a directory put in front of PATH (the shims)
 */
export function runClaude(sb, api, args, { timeout = 180000, env = {}, cwd, path: front } = {}) {
  return new Promise((resolve) => {
    const childEnv = baseEnv({ ...sb.env, ...(api ? { ANTHROPIC_API_KEY: "sk-ant-probe", ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}` } : {}), ...env });
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    if (front) childEnv.PATH = `${front}${path.delimiter}${childEnv.PATH || process.env.PATH || ""}`;
    const quoted = [CLAUDE, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    const where = cwd || sb.work;
    const started = Date.now();
    const child = viaShell() ? spawn(quoted, [], { cwd: where, env: childEnv, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn(CLAUDE, args, { cwd: where, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WIN });
    let out = "";
    let err = "";
    child.on("error", (e) => { err += String(e); });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => killTree(child), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(out); } catch { /* not one json document */ }
      resolve({ code, out, err, result, ms: Date.now() - started });
    });
  });
}

/** Run claude with no model involved (claude plugin ..., claude doctor): the same world, no fake API. */
export const claudeNoApi = (sb, args, opts = {}) => runClaude(sb, null, args, { timeout: 100000, ...opts });

/** The events of `--output-format stream-json --verbose`, parsed. */
export function streamEvents(r) {
  return r.out.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** The tool calls of a stream-json run, in order: [{ id, command, input, text, isError, decision }]. */
export function toolCalls(events) {
  const uses = new Map();
  const out = [];
  for (const e of events) {
    if (e.type === "assistant" && e.message && Array.isArray(e.message.content)) for (const b of e.message.content) if (b.type === "tool_use") uses.set(b.id, b);
    if (e.type === "user" && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type !== "tool_result") continue;
        const u = uses.get(b.tool_use_id) || {};
        const meta = (e.tool_result_meta || []).find((m) => m.id === b.tool_use_id) || {};
        out.push({ id: b.tool_use_id, tool: u.name, input: u.input || {}, command: (u.input || {}).command, text: typeof b.content === "string" ? b.content : JSON.stringify(b.content), isError: b.is_error === true, decision: meta.permission_decision || null, resultMeta: e.tool_use_result });
      }
    }
  }
  return out;
}

/** The result event of a stream-json run. */
export const resultEvent = (events) => events.find((e) => e.type === "result") || null;

export const hasText = (v, text) => JSON.stringify(v).includes(text);
