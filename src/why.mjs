// `why "<command>"`: does Claude Code run this Bash call inside the sandbox, outside it, or refuse to take it out, and does
// `autoAllowBashIfSandboxed` approve it without a prompt?
//
// The order is Claude Code's (the code that decides whether a call is sandboxed, read from 2.1.299 and put to 2.1.301 in CI):
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
  "regular": "goes through the regular permission flow: your allow rules and the permission mode decide whether you see a prompt (a read-only command such as ls passes)",
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

/**
 * The Bash permission rules that bear on the call, whatever the sandbox does:
 *   deny      a rule that refuses a part of it
 *   ask       a content-scoped rule that asks (the bare rule `Bash` is skipped for a sandboxed call, so it is returned apart)
 *   askBare   the bare ask rule
 *   allow     a rule that approves it: the bare `Bash`, or content rules that between them cover every part
 */
export function bashRules(command, settings) {
  const none = { deny: null, ask: null, askBare: null, allow: null };
  const parsed = parseBash(command);
  const rules = (settings.rules || []).filter((r) => !r.problem && !r.ignored && r.tool === "Bash");
  const by = (b) => rules.filter((r) => r.behavior === b);
  const out = { ...none, askBare: by("ask").find((r) => r.bare) || null };
  const bareAllow = by("allow").find((r) => r.bare) || null;
  if (!parsed.ok) { out.allow = bareAllow; return out; }
  const hit = (list, behavior, cmd) => list.find((r) => r.parsed && candidates(cmd, behavior).some((cand) => matches(r.parsed, cand.text))) || null;
  for (const cmd of parsed.cmds) {
    out.deny = out.deny || hit(by("deny"), "deny", cmd);
    out.ask = out.ask || hit(by("ask").filter((r) => !r.bare), "ask", cmd);
  }
  if (bareAllow) out.allow = bareAllow;
  else if (parsed.cmds.length && parsed.cmds.every((cmd) => hit(by("allow"), "allow", cmd))) out.allow = hit(by("allow"), "allow", parsed.cmds[0]);
  return out;
}

const ruleSummary = (r, settings) => (r ? { rule: r.raw, scope: r.scope, label: r.label, file: r.file, display: (settings.files.find((f) => f.path === r.file) || {}).display || r.file } : null);

/**
 * The approval of a call: how it is decided and what that is in `claude -p`, which cannot ask.
 *   how       "denied" | "ask" | "auto-allow" | "allow-rule" | "regular"
 *   outcome   "approved" | "asked" | "denied": `regular` is "asked" because a command that is not read-only needs a prompt
 */
function approvalOf({ command, settings, eff, runs }) {
  const rules = bashRules(command, settings);
  const approval = { how: null, outcome: null, text: null, shapes: [], denyRule: ruleSummary(rules.deny, settings), askRule: ruleSummary(rules.ask, settings), allowRule: ruleSummary(rules.allow, settings) };
  const done = (how, outcome, text) => { approval.how = how; approval.outcome = outcome; approval.text = text; return approval; };
  if (rules.deny) return done("denied", "denied", `refused by the deny rule ${rules.deny.raw}, whatever the sandbox does`);
  if (runs === "sandboxed" && eff.enabled) {
    if (rules.ask) return done("ask", "asked", `the ask rule ${rules.ask.raw} still asks, also for a sandboxed call`);
    if (rules.allow) return done("allow-rule", "approved", `approved by the allow rule ${rules.allow.raw}`);
    if (!eff.autoAllowBashIfSandboxed) return done("regular", "asked", `autoAllowBashIfSandboxed is false, so it ${APPROVAL.regular}`);
    approval.shapes = regularFlowShapes(command);
    if (approval.shapes.length) return done("regular", "asked", `it runs inside the sandbox, but ${APPROVAL.regular} (${approval.shapes[0].text})`);
    return done("auto-allow", "approved", APPROVAL["auto-allow"]);
  }
  if (rules.ask || rules.askBare) return done("ask", "asked", `the ask rule ${(rules.ask || rules.askBare).raw} asks`);
  if (rules.allow) return done("allow-rule", "approved", `approved by the allow rule ${rules.allow.raw}`);
  return done("regular", "asked", eff.enabled ? `it runs outside the sandbox, so it ${APPROVAL.regular}` : `the sandbox is off, so it ${APPROVAL.regular}`);
}

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
    result.reason = !eff.enabledInSettings ? "sandbox.enabled is not true in any settings file that applies" : "managed settings list enabledPlatforms without this system, so the sandbox settings do nothing here";
  } else if (analysis.excluded) {
    result.runs = "unsandboxed";
    result.basis = "excluded";
    result.verdict = "unsandboxed";
    result.excludedBy = analysis.parts.filter((p) => p.matched).map((p) => ({ part: p.text, entry: p.matched.entry, source: p.matched.source }));
    result.reason = "every part of the call is covered by an excludedCommands entry";
  } else if (retry && eff.allowUnsandboxedCommands) {
    result.runs = "unsandboxed";
    result.basis = "retry-allowed";
    result.verdict = "unsandboxed";
    result.reason = "allowUnsandboxedCommands is not false, so Claude Code honors dangerouslyDisableSandbox: true (a prompt, or your rules, decide whether it may run)";
  } else if (retry) {
    result.runs = "sandboxed";
    result.basis = "retry-refused";
    result.verdict = "refused";
    result.reason = `allowUnsandboxedCommands is false (${eff.strictBy.map((s) => `${s.display}${s.line ? `:${s.line}` : ""}`).join(", ")}), so Claude Code ignores dangerouslyDisableSandbox: the call runs inside the sandbox anyway`;
  } else {
    result.runs = "sandboxed";
    result.basis = analysis.callReasons.length ? "shape" : entries.length ? "no-match" : "no-entries";
    result.verdict = "sandboxed";
    result.reason = entries.length ? "no excludedCommands entry takes the whole call out of the sandbox" : "there is no excludedCommands entry";
  }

  result.approval = approvalOf({ command, settings, eff, runs: result.runs });

  // ---- notes -------------------------------------------------------------------------------------------------------------
  if (platform === "windows" || platform === "wsl1") result.notes.push(`This machine has no Bash sandbox (${platform === "windows" ? "Windows" : "WSL1"}), so on it every command runs outside one. The answer above is the one for Linux, WSL2 and macOS with these settings.`);
  if (eff.enabled && eff.adminRequired) result.notes.push(`The sandbox is admin-required (${eff.adminReasons.join("; ")}): entries from a repository's settings files are left out.`);
  if (result.ignoredEntries.length) result.notes.push(`${result.ignoredEntries.length} excludedCommands ${result.ignoredEntries.length === 1 ? "entry is" : "entries are"} ignored by Claude Code: ${result.ignoredEntries.map((e) => JSON.stringify(e.entry)).join(", ")}.`);
  result.notes.push("A PreToolUse hook, or a mod, can decide a call before any of this; hooks are not read. The model, not you, decides whether to retry with dangerouslyDisableSandbox.");
  return result;
}
