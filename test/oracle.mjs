// The oracle for `why`: put the calls of test/why-table.mjs to the real Claude Code binary with its sandbox on, at zero tokens, and
// say where each ran. The calls of rows that share their settings go to one `claude -p` session, one tool call for each row; the
// programs of the calls are stand-ins (test/claude-sandbox.mjs `shims`) that append "<name> <1|0>" to a file, 1 when Claude Code
// set SANDBOX_RUNTIME for the call, which it does for a command it runs in the sandbox. The fake API writes a line "#ROW <n>"
// to that file just before it sends call n, so each line belongs to the row that was running.
//
// Each run has its own throwaway HOME, USERPROFILE and CLAUDE_CONFIG_DIR, project folder and fake API. The permission mode is
// default with an allow rule for Bash, so that a call runs whether or not the sandbox took it out of the sandbox.
import fs from "node:fs";
import path from "node:path";
import { fakeApi, put, runClaude, sandbox, shims, streamEvents, toolCalls, resultEvent } from "./claude-sandbox.mjs";
import { world, fwd } from "./helpers.mjs";
import { loadSettings } from "../src/settings.mjs";
import { whyCommand } from "../src/why.mjs";
import { detectPlatform, realSys } from "../src/host.mjs";
import { FILES, PROGRAMS } from "./why-table.mjs";

const fill = (command, sb) => command.split("{BIN}").join(fwd(sb.bin));

/** Write the settings files of a group into a world (and the allow rule for Bash when asked). */
export function writeSettings(sb, settings, { allowBash = true } = {}) {
  const user = { ...(settings.user || {}) };
  if (allowBash) user.permissions = { ...(user.permissions || {}), allow: [...((user.permissions && user.permissions.allow) || []), "Bash"] };
  if (Object.keys(user).length) put(sb.user, user);
  if (settings.project) put(sb.project, settings.project);
  if (settings.local) put(sb.local, settings.local);
}

/** What the stand-ins recorded, by row: { [n]: [{ name, sandboxed }] }. */
export function readMarks(file) {
  const out = {};
  let row = -1;
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^#ROW (\d+)$/.exec(line);
    if (m) { row = Number(m[1]); out[row] = out[row] || []; continue; }
    const k = /^(\S+) ([01])$/.exec(line);
    if (k && row >= 0) out[row].push({ name: k[1], sandboxed: k[2] === "1" });
  }
  return out;
}

/** The place the row ran, from its marks: "sandboxed", "unsandboxed", "mixed" or null (nothing ran). */
export function placeOf(marks) {
  if (!marks || !marks.length) return null;
  if (marks.every((m) => m.sandboxed)) return "sandboxed";
  if (marks.every((m) => !m.sandboxed)) return "unsandboxed";
  return "mixed";
}

/**
 * Run the rows of one group (at most `chunk` of them in one session). Returns [{ row, place, marks, text, isError, decision }].
 */
export async function runChunk(group, rows, { timeout = 240000, args = [], approval = false } = {}) {
  const sb = sandbox("table");
  shims(sb, PROGRAMS);
  // timeout and stdbuf as every system has them: skip the options (and the duration), run the rest
  for (const name of ["timeout", "stdbuf"]) put(path.join(sb.bin, name), ["#!/bin/sh", 'while [ $# -gt 0 ]; do case "$1" in -k|-s|--kill-after|--signal) shift 2;; -*) shift;; *) break;; esac; done', name === "timeout" ? "shift" : ":", 'exec "$@"', ""].join("\n"), 0o755);
  for (const [rel, text] of Object.entries(FILES)) put(path.join(sb.work, rel), text, rel.endsWith(".sh") ? 0o755 : undefined);
  writeSettings(sb, group.settings, { allowBash: false });
  fs.writeFileSync(sb.marks, "");
  const calls = rows.map((r) => ({ command: fill(r.command, sb), ...(r.retry ? { dangerouslyDisableSandbox: true } : {}) }));
  const api = await fakeApi({ calls, before: (turn) => fs.appendFileSync(sb.marks, `#ROW ${turn}\n`) });
  try {
    const run = await runClaude(sb, api, ["-p", "PROBE-MAIN run the calls", "--output-format", "stream-json", "--verbose", "--permission-mode", approval ? "default" : "bypassPermissions", "--max-turns", String(calls.length + 3), ...args], { env: { CSD_MARKS: sb.marks, ...(group.env || {}) }, path: sb.bin, timeout });
    const events = streamEvents(run);
    const results = toolCalls(events);
    const marks = readMarks(sb.marks);
    const result = resultEvent(events);
    return rows.map((row, n) => {
      const call = results.find((c) => c.id === `toolu_call_${n}`) || null;
      return { row, place: placeOf(marks[n]), marks: marks[n] || [], text: call ? call.text : null, isError: call ? call.isError : null, decision: call ? call.decision : null, called: Boolean(call), session: { code: run.code, err: run.err.slice(0, 400), subtype: result ? result.subtype : null, denials: result && result.permission_denials ? result.permission_denials.length : null } };
    });
  } finally {
    await api.close();
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ }
  }
}

/** Run every group, with at most `limit` binaries at once. Results come back in the order of `rows`. */
export async function runGroups(groups, { limit = 4, chunk = 24, approval = false } = {}) {
  const jobs = [];
  for (const g of groups) for (let i = 0; i < g.rows.length; i += chunk) jobs.push({ group: g, rows: g.rows.slice(i, i + chunk) });
  const out = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await runChunk(jobs[i].group, jobs[i].rows, { approval });
        // a session that never reached its calls is run again
        if (r.some((x) => x.called)) break;
      }
      out.push(...r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

/** What `why` says for a row, in a world of its own (the same settings the binary gets). */
export function predict(row, { platform = "linux" } = {}) {
  const w = world("table");
  const s = row.settings || {};
  if (s.user) w.user(s.user);
  if (s.project) w.project(s.project);
  if (s.local) w.local(s.local);
  const settings = loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, platform: "linux" });
  return whyCommand({ command: row.command, settings, platform, retry: Boolean(row.retry) });
}

/** The first reason `why` gives for a call that stays sandboxed: a code of src/exclusion.mjs, or null. */
export function firstCode(result) {
  if (result.callReasons && result.callReasons.length) return result.callReasons[0].code;
  const p = result.parts.find((x) => !x.covered);
  return p && p.reasons.length ? p.reasons[0].code : null;
}

export { detectPlatform, realSys };

/** What the permission system did with a call of the approval table: "approved" (it ran), "denied" (a deny rule), or "asked". */
export function approvalOf(result) {
  if (result.place !== null) return "approved";
  if (/has been denied|denied by|deny rule/i.test(result.text || "")) return "denied";
  return "asked";
}
