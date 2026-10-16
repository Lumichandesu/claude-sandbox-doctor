// `check --live`: put the sandbox to the real Claude Code, at zero tokens. A throwaway config folder with the sandbox on, a fake
// Messages API on 127.0.0.1 that asks for three Bash commands, and `claude -p` pointed at it. Nothing leaves the machine and no
// model answers. The three commands:
//   inside   `printenv SANDBOX_RUNTIME`: Claude Code sets that variable for a command it runs in the sandbox
//   write    `touch <a file outside the project and the temp folder>`: the sandbox must refuse
//   network  `curl` to a host that is not allowed (a name that never resolves): the sandbox's proxy must refuse
// What each did is read from the tool results and the permission decisions that `--output-format stream-json` prints, and from
// the file system (the file is there or not). The binary is started with spawn (asynchronous: the fake API lives in this
// process and a synchronous start would block it) and with its standard input ignored, or -p waits for input forever.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const USAGE = { input_tokens: 1, output_tokens: 1 };

/** The `claude` to run: the path given, else the first on PATH. Returns { path } or { error }. */
export function findClaude(given, sys) {
  if (given) {
    const p = path.resolve(given);
    if (sys.exists(p)) return { path: p };
    // a bare name is looked up on the PATH, as a shell would
    const onPath = !/[\\/]/.test(given) ? sys.which(given) : null;
    return onPath ? { path: onPath } : { error: `${given} does not exist` };
  }
  for (const name of sys.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"]) {
    const p = sys.which(name);
    if (p) return { path: p };
  }
  return { error: "claude was not found on PATH (pass --claude <path>)" };
}

function messageEvents(id, model, blocks) {
  const ev = [["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: model || "x", content: [], stop_reason: null, usage: USAGE } }]];
  blocks.forEach((b, i) => {
    if (b.text !== undefined) {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } }]);
    } else {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.tool, input: {} } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  });
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: blocks.some((b) => b.tool) ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }]);
  ev.push(["message_stop", { type: "message_stop" }]);
  return ev;
}

/**
 * A fake Messages API: it answers the conversation with the Bash calls of `calls`, one for each turn, and then "PROBE-DONE". It
 * listens on 127.0.0.1 only, on a port the system picks.
 */
export function startFakeApi(calls) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!req.url.includes("/v1/messages")) { res.writeHead(404); res.end("{}"); return; }
      let j = {};
      try { j = JSON.parse(body); } catch { /* empty */ }
      requests.push(j);
      if (j.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_${requests.length}`, type: "message", role: "assistant", model: j.model || "x", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: USAGE }));
        return;
      }
      const turn = (j.messages || []).filter((m) => m.role === "assistant").length;
      const step = calls[turn];
      const events = step ? messageEvents(`msg_${requests.length}`, j.model, [{ tool: "Bash", id: `toolu_probe_${turn}`, input: step }]) : messageEvents(`msg_${requests.length}`, j.model, [{ text: "PROBE-DONE" }]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    server.unref();
    resolve({ port: server.address().port, requests, close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }) });
  }));
}

/** An environment for the binary: none of the machine's CLAUDE_*, ANTHROPIC_* and CLAUDECODE variables, no updates, no telemetry. */
export function scrubbedEnv(base, extra) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!/^(CLAUDE|ANTHROPIC|CLAUDECODE|AI_AGENT)/i.test(k)) env[k] = v;
  return { ...env, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_COLOR: "1", ...extra };
}

function killTree(child, platform) {
  try {
    if (platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}

const text = (b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content));

/** Reads the events of `claude -p --output-format stream-json --verbose`. Returns { calls: [{ id, text, isError, decision }], result, warnings }. */
export function readStream(out, err) {
  const events = out.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const calls = [];
  for (const e of events) {
    if (e.type !== "user" || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type !== "tool_result") continue;
      const meta = (e.tool_result_meta || []).find((m) => m.id === b.tool_use_id) || {};
      calls.push({ id: b.tool_use_id, text: text(b), isError: b.is_error === true, decision: meta.permission_decision || null });
    }
  }
  const result = events.find((e) => e.type === "result") || null;
  const warnings = String(err).split("\n").filter((l) => /Sandbox disabled|sandbox required|dependencies are missing|WITHOUT sandboxing/i.test(l)).map((l) => l.trim());
  return { calls, result, warnings };
}

/**
 * Say what a probe's tool result means.
 *   kind   "inside" | "write" | "network"
 *   call   { text, isError, decision } or undefined when the call never came back
 *   denied whether the result of the run lists this call under permission_denials
 */
export function judge(kind, call, { denied = false, fileCreated = false, warnings = [] } = {}) {
  if (!call) return { outcome: "unknown", evidence: "the call did not come back" };
  const t = call.text || "";
  const violation = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/.exec(t);
  const bwrap = /^bwrap: .*$/m.exec(t);
  if (bwrap && !violation) return { outcome: "error", evidence: `the sandbox could not start the command: ${bwrap[0].trim()}` };
  if (kind === "network" && (violation || /^403$/m.test(t))) {
    const v = violation ? /deny network-outbound ([^\s]+)/.exec(violation[1]) : null;
    return { outcome: "blocked", evidence: `the sandbox's proxy refused it${v ? ` and named ${v[1]}` : " (HTTP 403)"}` };
  }
  if (denied || /requested permissions to use|haven't granted it yet|requires approval|has been denied|Run outside of the sandbox/i.test(t)) {
    return { outcome: "refused", evidence: `Claude Code did not run it without asking${warnings.length ? ` (${warnings[0]})` : ""}` };
  }
  if (kind === "inside") {
    if (/^1\s*$/m.test(t)) return { outcome: "inside", evidence: "SANDBOX_RUNTIME=1: the command ran inside the sandbox" };
    return { outcome: "outside", evidence: "SANDBOX_RUNTIME is not set: the command ran outside the sandbox" };
  }
  if (kind === "write") {
    if (fileCreated) return { outcome: "outside", evidence: "the file outside the project was created" };
    const m = /(Read-only file system|Operation not permitted|Permission denied)/.exec(t);
    return m ? { outcome: "blocked", evidence: `the write failed: ${m[1]}` } : { outcome: "unknown", evidence: first(t) };
  }
  if (kind === "network") {
    if (/Could not resolve host|Network is unreachable|Temporary failure in name resolution/.test(t)) return { outcome: "blocked", evidence: "the command has no route out: it could not resolve the host" };
    if (/curl: .*not found|command not found/.test(t)) return { outcome: "unknown", evidence: "curl is not installed here" };
    return { outcome: "unknown", evidence: first(t) };
  }
  return { outcome: "unknown", evidence: first(t) };
}
const first = (s) => String(s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";

/**
 * Run the three probes through Claude Code.
 *   claude    the binary (a path)
 *   sys       the machine (src/host.mjs realSys)
 *   timeout   how long to wait for the whole run (ms)
 * Returns { version, probes: [{ id, title, command, outcome, evidence }], stderr, exit, warnings, ok }.
 */
export async function runLive({ claude, sys, timeout = 120000, extraSettings = {} }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csd-live-")));
  const home = path.join(root, "home");
  const cfg = path.join(root, "cfg");
  const work = path.join(root, "work");
  for (const d of [home, cfg, work]) fs.mkdirSync(d, { recursive: true });
  const outside = path.join(home, "sandbox-doctor-write-probe");
  const trust = { hasTrustDialogAccepted: true, allowedTools: [] };
  const projects = { [work]: trust, [work.replace(/\\/g, "/")]: trust };
  fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects }));
  const settings = { sandbox: { enabled: true, ...extraSettings }, permissions: { allow: ["Bash(printenv SANDBOX_RUNTIME)"] } };
  fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify(settings, null, 2));
  const probes = [
    { id: "inside", kind: "inside", title: "a command runs inside the sandbox", command: "printenv SANDBOX_RUNTIME" },
    { id: "write", kind: "write", title: "a write outside the project", command: `touch ${JSON.stringify(outside)}` },
    { id: "network", kind: "network", title: "a connection to a host that is not allowed", command: 'curl -sS -m 10 -o /dev/null -w "%{http_code}" http://sandbox-doctor-probe.invalid/' },
  ];
  const api = await startFakeApi(probes.map((p) => ({ command: p.command, description: p.title })));
  const env = scrubbedEnv(sys.env, { CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home, ANTHROPIC_API_KEY: "sk-ant-probe", ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}` });
  const args = ["-p", "PROBE-MAIN check the sandbox", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--max-turns", String(probes.length + 3)];
  const viaShell = sys.platform === "win32" && !/\.exe$/i.test(claude);
  const version = (() => { const r = spawnSync(claude, ["--version"], { encoding: "utf8", env, windowsHide: true, shell: viaShell, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }); return String(r.stdout || "").trim(); })();
  const result = { version, probes: [], stderr: "", exit: null, warnings: [], ok: false, root: null };
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(claude, args, { cwd: work, env, windowsHide: true, shell: viaShell, stdio: ["ignore", "pipe", "pipe"], detached: sys.platform !== "win32" });
      let out = "";
      let err = "";
      child.on("error", (e) => { err += String(e); });
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      const timer = setTimeout(() => killTree(child, sys.platform), timeout);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
    result.exit = run.code;
    result.stderr = run.err.split("\n").filter((l) => !/^\[SandboxDebug\]/.test(l)).join("\n").trim().slice(0, 2000);
    const s = readStream(run.out, run.err);
    result.warnings = s.warnings;
    const denials = new Set(((s.result && s.result.permission_denials) || []).map((d) => d.tool_use_id));
    result.startError = s.result && s.result.is_error ? first((s.result.errors || []).join("\n")) || first(run.err) : null;
    probes.forEach((p, i) => {
      const call = s.calls.find((c) => c.id === `toolu_probe_${i}`);
      const j = judge(p.kind, call, { denied: denials.has(`toolu_probe_${i}`), fileCreated: p.kind === "write" && fs.existsSync(outside), warnings: s.warnings });
      result.probes.push({ id: p.id, title: p.title, command: p.command, outcome: j.outcome, evidence: j.evidence, decision: call && call.decision ? call.decision.decision : null, text: call ? call.text.slice(0, 400) : null });
    });
    if (result.startError && !s.calls.length) for (const p of result.probes) { p.outcome = "error"; p.evidence = result.startError; }
    const by = Object.fromEntries(result.probes.map((p) => [p.id, p.outcome]));
    result.ok = by.inside === "inside" && by.write === "blocked" && by.network === "blocked";
  } finally {
    await api.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ }
  }
  return result;
}
