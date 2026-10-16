// `why "<command>"`: does Claude Code run this Bash call inside the sandbox, outside it, or refuse to take it out, and does
// `autoAllowBashIfSandboxed` approve it without a prompt?
//
// The order is Claude Code's (the code that decides whether a call is sandboxed, read from 2.1.299):
//   1. the sandbox is not on (sandbox.enabled is not true, or managed enabledPlatforms leaves this system out): outside
//   2. the call carries `dangerouslyDisableSandbox: true` and allowUnsandboxedCommands is not false: outside (the retry)
//   3. every part of the call is covered by an excludedCommands entry: outside
//   4. otherwise: inside
// With allowUnsandboxedCommands false the parameter of step 2 is ignored, and the call stays inside unless step 3 applies:
// that is the "refused" of `why --retry`.
import { analyzeCall } from "./exclusion.mjs";
import { mergeSandbox } from "./sandbox.mjs";
import { parseBash } from "./engine/shell.mjs";
import { candidates } from "./engine/wrappers.mjs";
import { matches } from "./engine/pattern.mjs";
import { SAFE_ENV } from "./facts.mjs";

const APPROVAL = {
  "auto-allow": "approved without a prompt: it runs inside the sandbox and autoAllowBashIfSandboxed is on",
  "regular": "goes through the regular permission flow: your allow rules and the permission mode decide whether you see a prompt",
};

/** The shapes of a call that run sandboxed but are still not approved on their own (docs: Auto-allow mode). */
function regularFlowShapes(command) {
  const out = [];
  const parsed = parseBash(command);
  if (!parsed.ok) return out;
  for (const c of parsed.cmds) {
    const unsafe = c.assigns.find((a) => !SAFE_ENV.has(a.value.slice(0, a.value.indexOf("="))));
    if (unsafe && c.argv.length) out.push({ code: "assignment-prefix", text: `a variable set in front of the command (${unsafe.value.split("=")[0]}=...) can change which program runs, like FOO=bar npm test` });
    const first = c.argv[0] && c.argv[0].value;
    if (first === "eval") out.push({ code: "eval", text: "eval runs text as shell code" });
    for (const a of c.argv.slice(1)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(a.value);
      if (m && !a.value.startsWith("-") && !SAFE_ENV.has(m[1])) { out.push({ code: "assignment-argument", text: `an argument of the form ${m[1]}=value (as in make CC=clang)` }); break; }
    }
    if (c.redirs.some((r) => r.target && /^\/dev\/(tcp|udp)\//.test(r.target.value))) out.push({ code: "dev-tcp", text: "a redirection to /dev/tcp or /dev/udp" });
  }
  return out;
}

/** The permission rules that already decide the call, whatever the sandbox does: a deny rule, an ask rule. */
function ruleMatches(command, settings) {
  const parsed = parseBash(command);
  if (!parsed.ok) return { deny: null, ask: null };
  const active = { deny: [], ask: [] };
  for (const r of settings.rules || []) {
    if (r.problem || r.ignored || r.tool !== "Bash" || r.behavior === "allow") continue;
    active[r.behavior].push(r);
  }
  const find = (list, behavior) => {
    for (const r of list) {
      if (!r.parsed) continue;
      for (const c of parsed.cmds) {
        if (c.ctx.length === 0 || true) {
          const hit = candidates(c, behavior).some((cand) => matches(r.parsed, cand.text));
          if (hit) return r;
        }
      }
    }
    return null;
  };
  return { deny: find(active.deny, "deny"), ask: find(active.ask.filter((r) => !r.bare), "ask"), askBare: active.ask.find((r) => r.bare) || null };
}

const ruleSummary = (r, settings) => (r ? { rule: r.raw, scope: r.scope, label: r.label, file: r.file, display: (settings.files.find((f) => f.path === r.file) || {}).display || r.file } : null);

/**
 * Ask the question for one call.
 *   command   what Claude sends to the Bash tool
 *   settings  from src/settings.mjs
 *   platform  "linux" | "wsl2" | "wsl1" | "macos" | "windows": the system the question is about
 *   retry     the model sets dangerouslyDisableSandbox: true (after the sandbox blocked something)
 */
export function whyCommand({ command, settings, platform = "linux", retry = false, merged }) {
  const m = merged || mergeSandbox(settings, { platform });
  const eff = m.effective;
  const entries = eff.excludedCommands.map((e) => ({ raw: typeof e.value === "string" ? e.value : String(e.value), source: e.sources[0] }));
  const analysis = analyzeCall(command, entries);
  const result = {
    command,
    retry,
    platform,
    sandbox: { on: eff.enabled, enabledInSettings: eff.enabledInSettings, platformListed: eff.platformListed, failIfUnavailable: eff.failIfUnavailable, adminRequired: eff.adminRequired },
    entries: entries.map((e) => ({ entry: e.raw, source: e.source })),
    ignoredEntries: eff.ignoredExcluded.map((e) => ({ entry: e.value, why: e.ignored.map((i) => ({ reason: i.reason, source: i.source })) })),
    callReasons: analysis.callReasons,
    parts: analysis.parts.map((p) => ({ text: p.text, covered: p.covered, trivially: p.trivially, matched: p.matched, reasons: p.reasons, normalized: p.normalized })),
    excludedBy: [],
    verdict: null,
    basis: null,
    runs: null,
    strict: !eff.allowUnsandboxedCommands,
    strictBy: eff.strictBy,
    approval: null,
    notes: [],
  };

  // ---- 1 to 4 ------------------------------------------------------------------------------------------------------------
  if (!eff.enabled) {
    result.runs = "unsandboxed";
    result.basis = "sandbox-off";
    result.verdict = "unsandboxed";
    result.reason = !eff.enabledInSettings ? "sandbox.enabled is not true in any settings file that applies" : `managed settings list enabledPlatforms without this system, so the sandbox settings do nothing here`;
  } else if (analysis.excluded) {
    result.runs = "unsandboxed";
    result.basis = "excluded";
    result.verdict = "unsandboxed";
    result.excludedBy = analysis.parts.filter((p) => p.matched).map((p) => ({ part: p.text, entry: p.matched.entry, source: p.matched.source }));
    result.reason = "every part of the call is covered by an excludedCommands entry";
  } else if (retry) {
    if (eff.allowUnsandboxedCommands) {
      result.runs = "unsandboxed";
      result.basis = "retry-allowed";
      result.verdict = "unsandboxed";
      result.reason = "allowUnsandboxedCommands is not false, so Claude Code honors dangerouslyDisableSandbox: true (a prompt, or your rules, decide whether it may)";
    } else {
      result.runs = "sandboxed";
      result.basis = "retry-refused";
      result.verdict = "refused";
      result.reason = `allowUnsandboxedCommands is false (${eff.strictBy.map((s) => `${s.display}${s.line ? `:${s.line}` : ""}`).join(", ")}), so Claude Code ignores dangerouslyDisableSandbox: the call runs inside the sandbox anyway`;
    }
  } else {
    result.runs = "sandboxed";
    result.basis = analysis.callReasons.length ? "shape" : entries.length ? "no-match" : "no-entries";
    result.verdict = "sandboxed";
    result.reason = entries.length ? "no excludedCommands entry takes the whole call out of the sandbox" : "there is no excludedCommands entry";
  }

  // ---- the approval ---------------------------------------------------------------------------------------------------------
  const rules = ruleMatches(command, settings);
  const approval = { how: null, text: null, shapes: [], denyRule: ruleSummary(rules.deny, settings), askRule: ruleSummary(rules.ask, settings) };
  if (rules.deny) { approval.how = "denied"; approval.text = `refused by the deny rule ${rules.deny.raw}, whatever the sandbox does`; }
  else if (!eff.enabled) { approval.how = "regular"; approval.text = `the sandbox is off, so ${APPROVAL.regular}`; }
  else if (result.runs === "sandboxed") {
    if (!eff.autoAllowBashIfSandboxed) { approval.how = "regular"; approval.text = `autoAllowBashIfSandboxed is false, so ${APPROVAL.regular}`; }
    else {
      approval.shapes = regularFlowShapes(command);
      if (rules.ask) { approval.how = "ask"; approval.text = `the ask rule ${rules.ask.raw} still asks, also for a sandboxed call`; }
      else if (approval.shapes.length) { approval.how = "regular"; approval.text = `this call runs inside the sandbox, but ${APPROVAL.regular} (${approval.shapes[0].text})`; }
      else { approval.how = "auto-allow"; approval.text = APPROVAL["auto-allow"]; }
    }
  } else {
    approval.how = rules.ask ? "ask" : "regular";
    approval.text = rules.ask ? `the ask rule ${rules.ask.raw} asks` : `it runs outside the sandbox, so it ${APPROVAL.regular.replace(/^goes /, "goes ")}`;
  }
  result.approval = approval;

  // ---- notes -------------------------------------------------------------------------------------------------------------
  if (platform === "windows" || platform === "wsl1") result.notes.push(`This machine has no Bash sandbox (${platform === "windows" ? "Windows" : "WSL1"}), so on it every command runs outside one. The answer above is the one for Linux, WSL2 and macOS with these settings.`);
  if (eff.enabled && eff.adminRequired) result.notes.push(`The sandbox is admin-required (${eff.adminReasons.join("; ")}): entries from a repository's settings files are left out.`);
  if (result.ignoredEntries.length) result.notes.push(`${result.ignoredEntries.length} excludedCommands ${result.ignoredEntries.length === 1 ? "entry is" : "entries are"} ignored by Claude Code: ${result.ignoredEntries.map((e) => JSON.stringify(e.entry)).join(", ")}.`);
  result.notes.push("A PreToolUse hook, or a mod, can decide a call before any of this; hooks are not read. The model, not you, decides whether to retry with dangerouslyDisableSandbox.");
  return result;
}
