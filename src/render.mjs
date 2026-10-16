// Plain-text, markdown and JSON reports. Text goes to a terminal (coloured when it is one), markdown is what the skill hands to
// Claude, JSON is for other tools. A report holds file paths, line numbers, key names, the commands you asked about and what the
// settings say; it never holds a whole file.
import { VERSION } from "./version.mjs";

export const palette = (on) => {
  const c = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { red: c(31), green: c(32), yellow: c(33), blue: c(36), dim: c(2), bold: c(1) };
};

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pad = (s, n) => String(s).padEnd(n);

/** The text broken into lines of at most `width` columns at spaces (a longer word has a line of its own). */
export function wrap(text, width) {
  const lines = [];
  for (const para of String(text).replace(/\r/g, "").split(/\n+/)) {
    let line = "";
    for (const word of para.trim().split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  }
  return lines;
}
const indent = (text, first, rest, width = 100) => wrap(text, width - first.length).map((l, i) => `${i === 0 ? first : rest}${l}`);
const clip = (s, n) => { const t = String(s).replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
const where = (s) => (s ? `${s.display}${s.line ? `:${s.line}` : ""}` : "");
const q = (v) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));

/** Remove what a person has no use for from a model before it goes out as JSON: parsed rules, cycles. */
export function strip(model) {
  return JSON.parse(JSON.stringify(model, (key, value) => (key === "parsed" || key === "analysis" ? undefined : value)));
}

const STATUS = { ok: "ok  ", fail: "FAIL", warn: "warn", info: "    ", skip: "skip" };

// ------------------------------------------------------------------------------------------------------------
// check
// ------------------------------------------------------------------------------------------------------------

export function renderCheck(m, { color = false } = {}) {
  const p = palette(color);
  const out = [];
  out.push(`${p.bold(`claude-sandbox-doctor ${VERSION}`)}  can the Bash sandbox work here`);
  out.push(`system    ${m.platform.label}`);
  out.push("");
  const tag = (s) => (s === "fail" ? p.red(STATUS[s]) : s === "warn" ? p.yellow(STATUS[s]) : s === "ok" ? p.green(STATUS[s]) : p.dim(STATUS[s]));
  for (const it of m.items) {
    out.push(...indent(it.title, `  ${tag(it.status)}  `, "        "));
    if (it.detail) out.push(...indent(it.detail, "          ", "          ").map((l) => p.dim(l)));
    if (it.fix && it.status !== "ok") out.push(...indent(`fix: ${it.fix}`, "          ", "          "));
  }
  out.push("");
  out.push(m.summary);
  if (m.live) {
    out.push("");
    out.push(p.bold("Claude Code, put to the test (--live)"));
    if (m.live.skipped) out.push(...indent(`not run: ${m.live.reason}`, "  ", "  "));
    else {
      out.push(`  claude    ${m.live.version || m.live.claude}`);
      for (const pr of m.live.probes) {
        const t = pr.outcome === "blocked" || pr.outcome === "inside" ? p.green(pr.outcome.padEnd(8)) : pr.outcome === "unknown" ? p.yellow(pr.outcome.padEnd(8)) : p.red(pr.outcome.padEnd(8));
        out.push(...indent(`${pr.title}`, `  ${t}  `, "            "));
        out.push(...indent(pr.evidence, "            ", "            ").map((l) => p.dim(l)));
      }
      if (m.live.warnings && m.live.warnings.length) out.push(...indent(`Claude Code said: ${m.live.warnings.join(" ")}`, "  ", "  "));
      out.push(m.live.ok ? "The sandbox kept the command inside, refused the write and refused the connection." : "The probes did not all end as a working sandbox would end them.");
    }
  } else if (m.hasSandbox && m.ok) {
    out.push(p.dim("Not tried: a real Claude Code run (check --live does that, at zero tokens), the proxy that checks the allowed domains, the seccomp helper."));
  }
  return `${out.join("\n")}\n`;
}

/** The short form the skill hands to Claude: at most 9 lines, and it never exits 1. */
export function markdownCheck(m) {
  const out = [];
  out.push(`## sandbox-doctor check: ${m.platform.label}`);
  for (const it of m.items) {
    if (it.status === "info" || it.status === "skip") continue;
    out.push(`- ${it.status.toUpperCase()} ${clip(it.title, 160)}${it.status !== "ok" && it.fix ? ` Fix: ${clip(it.fix, 200)}` : ""}`);
  }
  out.push(m.summary);
  return `${out.slice(0, 9).join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------------------------
// show
// ------------------------------------------------------------------------------------------------------------

const VALUE_KEYS = ["enabled", "failIfUnavailable", "autoAllowBashIfSandboxed", "allowUnsandboxedCommands", "enableWeakerNestedSandbox", "enableWeakerNetworkIsolation", "allowAppleEvents", "bwrapPath", "socatPath", "enabledPlatforms", "filesystem.disabled", "filesystem.allowManagedReadPathsOnly", "network.allowManagedDomainsOnly", "network.strictAllowlist", "network.allowAllUnixSockets", "network.allowLocalBinding", "network.httpProxyPort", "network.socksProxyPort", "network.tlsTerminate", "ripgrep", "credentials.allowPlaintextInject", "credentials.sigv4", "ignoreViolations"];
const LIST_ORDER = ["excludedCommands", "network.allowedDomains", "network.deniedDomains", "filesystem.allowWrite", "filesystem.denyWrite", "filesystem.denyRead", "filesystem.allowRead", "network.allowUnixSockets", "network.allowMachLookup", "credentials.files", "credentials.envVars", "credentials.awsPairs"];

export function renderShow(m, { color = false } = {}) {
  const p = palette(color);
  const out = [];
  out.push(`${p.bold(`claude-sandbox-doctor ${VERSION}`)}  the sandbox settings Claude Code merges`);
  out.push(`project   ${m.project}`);
  out.push(`config    ${m.configDir}${m.configSource === "CLAUDE_CONFIG_DIR" ? "  (from CLAUDE_CONFIG_DIR)" : ""}`);
  out.push(`system    ${m.platform.label}${m.platform.hasSandbox ? "" : "  (no Bash sandbox here: the answers below are for Linux, WSL2 and macOS)"}`);
  out.push("");
  out.push(p.bold("Settings files, highest precedence first"));
  const wf = Math.max(...m.files.map((f) => f.display.length), 10);
  for (const f of m.files) {
    const state = !f.exists ? "not found" : f.ignored ? `ignored by Claude Code: ${f.ignored.detail}` : f.sandboxKeys ? `read, ${plural(f.sandboxKeys, "sandbox key")}` : "read, no sandbox keys";
    out.push(`  ${pad(f.scope, 8)} ${pad(f.display, wf)}  ${f.ignored ? p.red(state) : f.exists ? state : p.dim(state)}`);
  }
  const e = m.effective;
  out.push("");
  out.push(p.bold("What the keys add up to"));
  out.push(`  sandbox on          ${e.enabled ? "yes" : "no"}  ${e.enabled ? "" : !e.enabledInSettings ? "(sandbox.enabled is not true in any file that applies)" : `(managed enabledPlatforms leaves out ${e.claudePlatform})`}`.trimEnd());
  out.push(`  retry outside       ${e.allowUnsandboxedCommands ? "allowed: Claude may retry a failed command with dangerouslyDisableSandbox" : `not allowed (allowUnsandboxedCommands is false in ${e.strictBy.map(where).join(", ")}): Claude Code ignores the parameter`}`);
  out.push(`  auto-allow          ${e.autoAllowBashIfSandboxed ? "on: a sandboxed command runs without a prompt" : "off: a sandboxed command goes through the regular permission flow"}`);
  out.push(`  failIfUnavailable   ${e.failIfUnavailable ? "on: Claude Code refuses to start where the sandbox cannot" : "off: where the sandbox cannot start, commands run without it and a warning says so"}`);
  out.push(`  admin-required      ${e.adminRequired ? `yes (${e.adminReasons.join("; ")})` : "no"}`);
  out.push(`  read block          ${e.blockReads.on ? `on (permissions.blockReadsOutsideWorkingDirectories in ${e.blockReads.sources.map(where).join(", ")})` : "off"}`);
  out.push("");
  out.push(p.bold("Merged sandbox settings"));
  let any = false;
  const wk = 36;
  for (const key of VALUE_KEYS) {
    const v = m.values[key];
    if (!v) continue;
    any = true;
    const w = v.winner;
    const shown = w ? q(w.value) : "(ignored)";
    out.push(`  ${pad(key, wk)} ${pad(clip(shown, 34), 35)}${w ? `${w.source.scope} ${where(w.source)}` : ""}`.trimEnd());
    for (const s of v.shadowed) out.push(p.dim(`      shadowed: ${clip(q(s.value), 40)} in ${s.source.scope} ${where(s.source)}`));
    for (const s of v.set.filter((x) => x.ignored)) out.push(p.yellow(`      ignored: ${clip(q(s.value), 40)} in ${s.source.scope} ${where(s.source)}: ${s.ignored}`));
  }
  for (const key of LIST_ORDER) {
    const list = m.lists[key];
    if (!list) continue;
    any = true;
    const used = list.filter((it) => it.sources.length);
    out.push(`  ${pad(key, wk)} ${plural(used.length, "entry", "entries")}${list.length > used.length ? `, ${list.length - used.length} ignored` : ""}`);
    for (const it of list) {
      const val = typeof it.value === "string" ? q(it.value) : clip(q(it.value), 60);
      if (it.sources.length) out.push(`      ${pad(clip(val, 44), 45)}${it.sources.map((s) => `${s.scope} ${where(s)}`).join(", ")}`);
      for (const ig of it.ignored) out.push(p.yellow(`      ${pad(clip(val, 44), 45)}${ig.source.scope} ${where(ig.source)}: ignored (${ig.reason})`));
    }
  }
  if (!any) out.push(p.dim("  The files set no sandbox key."));
  const d = m.derived;
  const dLines = [];
  const add = (title, arr, fmt) => { if (arr.length) { dLines.push(`  ${title}`); for (const x of arr) dLines.push(`      ${pad(clip(fmt(x), 44), 45)}${x.source.scope} ${where(x.source)}`); } };
  add("Edit allow rules (added to filesystem.allowWrite)", d.allowWrite, (x) => x.rule);
  add("Edit deny rules (added to filesystem.denyWrite)", d.denyWrite, (x) => x.rule);
  add("Read deny rules (added to filesystem.denyRead)", d.denyRead, (x) => x.rule);
  add("WebFetch(domain:...) allow rules (added to network.allowedDomains)", d.allowedDomains, (x) => x.rule);
  add("WebFetch(domain:...) deny rules (added to network.deniedDomains)", d.deniedDomains, (x) => x.rule);
  add("permissions.additionalDirectories (sandboxed commands may write there)", d.additionalDirectories, (x) => x.value);
  if (dLines.length) { out.push(""); out.push(p.bold("Permission settings that reach the sandbox")); out.push(...dLines); }
  if (m.notes.length) { out.push(""); for (const n of m.notes) out.push(...indent(n, "Note: ", "      ")); }
  out.push("");
  out.push("Not read by this tool:");
  for (const n of m.notRead) out.push(...indent(n, "  - ", "    "));
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------------------------
// why
// ------------------------------------------------------------------------------------------------------------

export function renderWhy(m, { color = false } = {}) {
  const p = palette(color);
  const out = [];
  out.push(`${p.bold(`claude-sandbox-doctor ${VERSION}`)}  where a Bash call runs`);
  out.push(`project   ${m.project}`);
  out.push(`call      ${clip(m.command, 200)}${m.retry ? "   (as a retry with dangerouslyDisableSandbox: true)" : ""}`);
  out.push("");
  const head = m.verdict === "sandboxed" ? p.green("inside the sandbox") : m.verdict === "refused" ? p.red("refused") : p.yellow("outside the sandbox");
  out.push(`${p.bold("Runs")}      ${head}`);
  out.push(...indent(m.reason, "          ", "          "));
  if (m.verdict === "unsandboxed" && m.basis === "excluded") {
    for (const x of m.excludedBy) out.push(`          ${pad(clip(x.part, 40), 41)}matches ${q(x.entry)}${x.source ? `  ${x.source.scope} ${where(x.source)}` : ""}`);
  }
  if (m.verdict !== "unsandboxed" && (m.basis === "shape" || m.basis === "no-match" || m.basis === "retry-refused")) {
    for (const r of m.callReasons) out.push(...indent(`the whole call: ${r.text}`, "          ", "          "));
    for (const part of m.parts) {
      if (part.covered && !m.callReasons.length) { out.push(`          ${pad(clip(part.text, 36), 37)}${part.trivially ? "a harmless assignment: passes" : `matches ${q(part.matched.entry)}`}`); continue; }
      if (part.covered) continue;
      const why = part.reasons.map((r) => r.text).join("; ");
      out.push(...indent(`${clip(part.text, 36)}: ${why}`, "          ", "              "));
    }
  }
  if (m.entries.length) {
    out.push("");
    out.push(p.bold("excludedCommands that apply"));
    for (const e of m.entries) out.push(`  ${pad(q(e.entry), 40)}${e.source ? `${e.source.scope} ${where(e.source)}` : ""}`);
  } else if (m.basis !== "sandbox-off") out.push(p.dim("\nNo excludedCommands entry applies."));
  if (m.ignoredEntries.length) for (const e of m.ignoredEntries) for (const w of e.why) out.push(p.yellow(`  ${pad(q(e.entry), 40)}${w.source.scope} ${where(w.source)}: ignored (${w.reason})`));
  out.push("");
  out.push(`${p.bold("Approval")}  ${m.approval.text}`);
  if (m.retry === false && m.verdict === "sandboxed") {
    out.push(...indent(m.strict ? "If Claude retries with dangerouslyDisableSandbox: refused, Claude Code ignores the parameter (allowUnsandboxedCommands is false). Ask with --retry." : "If Claude retries with dangerouslyDisableSandbox: it runs outside the sandbox (allowUnsandboxedCommands is not false); you are asked, or your allow rules decide. Ask with --retry.", "", "          "));
  }
  if (m.notes.length) { out.push(""); for (const n of m.notes) out.push(...indent(n, "Note: ", "      ")); }
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------------------------
// lint
// ------------------------------------------------------------------------------------------------------------

export function renderLint(m, { color = false } = {}) {
  const p = palette(color);
  const out = [];
  out.push(`${p.bold(`claude-sandbox-doctor ${VERSION}`)}  lint`);
  out.push(`project   ${m.project}`);
  out.push(`system    ${m.platform.label}`);
  out.push("");
  const byFile = new Map();
  for (const f of m.findings) { if (!byFile.has(f.file)) byFile.set(f.file, { display: f.display, label: f.scope, items: [] }); byFile.get(f.file).items.push(f); }
  if (!m.findings.length) out.push(p.green("  No finding."));
  for (const [, g] of byFile) {
    out.push(`${g.display}  ${g.label} settings`);
    for (const f of g.items) {
      const sev = f.severity === "error" ? p.red("error  ") : f.severity === "warning" ? p.yellow("warning") : p.blue("note   ");
      out.push(`  ${sev} ${pad(f.id, 22)} line ${f.line || "?"}  ${f.keyPath || ""}`.trimEnd());
      out.push(...indent(f.message, "      ", "      "));
      if (f.fix) out.push(...indent(`fix: ${f.fix}`, "      ", "      "));
    }
    out.push("");
  }
  out.push(`${plural(m.counts.error, "error")}, ${plural(m.counts.warning, "warning")}, ${plural(m.counts.note, "note")} in ${plural(m.files.filter((f) => f.exists).length, "file")}`);
  return `${out.join("\n")}\n`;
}

/** The short form the skill hands to Claude: at most 12 findings, 300 characters a line; it never exits 1. */
export function markdownLint(m) {
  const out = [];
  const read = m.files.filter((f) => f.exists).length;
  out.push(`## sandbox-doctor lint: ${m.project}`);
  out.push(`${plural(read, "settings file")} read, ${plural(m.counts.error, "error")}, ${plural(m.counts.warning, "warning")}, ${plural(m.counts.note, "note")}. System: ${m.platform.label}.`);
  const show = m.findings.filter((f) => f.severity !== "note");
  for (const f of show.slice(0, 12)) {
    const line = `- ${f.severity.toUpperCase()} \`${f.id}\` ${f.display}${f.line ? `:${f.line}` : ""} \`${f.keyPath || ""}\`: ${f.message}${f.fix ? ` Fix: ${f.fix}` : ""}`.replace(/\s+/g, " ");
    out.push(line.length > 300 ? `${line.slice(0, 297)}...` : line);
  }
  if (show.length > 12) out.push(`- ... and ${show.length - 12} more (run \`claude-sandbox-doctor lint\`)`);
  if (!show.length) out.push("- No error and no warning.");
  return `${out.join("\n")}\n`;
}
