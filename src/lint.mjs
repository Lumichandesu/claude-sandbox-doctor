// `lint`: sandbox settings that can never take effect, or that do something other than what they look like they do.
//
// Each finding names the file and line, says what Claude Code does about it, and says what to write. Its `basis` says where the
// rule comes from: "binary" (put to the real Claude Code in CI, test/e2e-claude.test.mjs), "code" (read from the shipped code
// of Claude Code 2.1.299, not yet run), or "docs" (the documentation says so). The README lists which rule is which.
// Severities: error (Claude Code drops a file, or refuses to start), warning (the setting cannot do what it says), note
// (worth knowing, nothing is lost).
import { mergeSandbox } from "./sandbox.mjs";
import { deadEntryReason } from "./exclusion.mjs";
import { SANDBOX_KEYS, SCOPE_TEXT, INTERPRETERS } from "./facts.mjs";
import { parseContent } from "./engine/pattern.mjs";

const SEVERITY_ORDER = { error: 0, warning: 1, note: 2 };

/** What is wrong with a domain entry of allowedDomains or deniedDomains: null when it can match a host. */
export function domainProblem(raw) {
  if (typeof raw !== "string") return { code: "domain-type", text: "is not a string", fix: "Write the host name as a string." };
  if (raw === "") return { code: "domain-empty", text: "is empty and matches nothing", fix: "Remove it." };
  if (raw !== raw.trim()) return { code: "domain-space", text: "has a space at its start or end, so it is not the host name", fix: `Write ${JSON.stringify(raw.trim())}.` };
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw);
  if (scheme) {
    const host = raw.slice(scheme[0].length).split(/[/?#]/)[0];
    return { code: "domain-scheme", text: `has a scheme (${scheme[0]}), so it is compared with the host name as a whole and never equals one`, fix: `Write the host only: ${JSON.stringify(host)}.` };
  }
  const bracket = /^\[([^\]]*)\](?::(.*))?$/.exec(raw);
  if (!bracket && /[/?#@\\]/.test(raw)) {
    const host = raw.split(/[/?#]/)[0].replace(/^.*@/, "");
    return { code: "domain-path", text: "has a path, a query or a user name in it, but the sandbox's proxy compares host names (and a port), so it never matches", fix: `Write the host only: ${JSON.stringify(host)}.` };
  }
  if (bracket) {
    if (bracket[2] !== undefined && !/^[1-9][0-9]{0,4}$/.test(bracket[2]) || (bracket[2] !== undefined && Number(bracket[2]) > 65535)) return { code: "domain-port", text: `has the port ${JSON.stringify(bracket[2])}, which is not 1 to 65535 without a leading zero, so the whole entry is read as a host name and never matches`, fix: "Write a port from 1 to 65535, or none." };
    return null;
  }
  const colons = (raw.match(/:/g) || []).length;
  if (colons > 1) return { code: "domain-ipv6", text: "has more than one colon: it is read as an IPv6 address without its brackets, and `claude doctor` warns that such an entry is unreliable", fix: `Write IPv6 literals in brackets, with the port after them: "[${raw.split(":").slice(0, -1).join(":")}]:${raw.split(":").pop()}".` };
  let host = raw;
  if (colons === 1) {
    const [h, port] = raw.split(":");
    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return { code: "domain-port", text: `has the port ${JSON.stringify(port)}, which is not 1 to 65535 without a leading zero, so the whole entry is read as a host name and never matches`, fix: "Write a port from 1 to 65535, or none." };
    host = h;
  }
  if (host === "*") return null;
  if (host.includes("*") && !/^\*\.[^*]+$/.test(host)) return { code: "domain-wildcard", text: "has a * that is not the first label (only `*.example.com` and `*` work), so it is compared as plain text and never matches a host", fix: "Write `*.example.com` for the subdomains of example.com." };
  if (!/^(?:\*\.)?[A-Za-z0-9._-]+$/.test(host)) return { code: "domain-chars", text: "has characters a host name does not", fix: "Write the host name as it appears in the URL." };
  return null;
}

/**
 * Every rule: how serious it is, where its claim comes from, and what it finds. basis "binary" means the claim was put to the real
 * Claude Code in CI (the README says which tests); "docs" means the documentation says so and the binary was not asked; "mixed"
 * (key-scope) means each finding says which of the two it is. The README's table of rules is held to this one.
 */
export const RULES = {
  "file-ignored": { severity: "error", basis: "binary", what: "a settings file that Claude Code drops whole: a comment, a trailing comma, or a value of the wrong type in its sandbox block" },
  "unknown-key": { severity: "warning", basis: "binary", what: "a key the sandbox block does not have (a typo), which Claude Code ignores without a word" },
  "key-scope": { severity: "warning", basis: "mixed", what: "a key that only managed settings (or only user and managed settings) may set, in a file that may not (binary for bwrapPath, socatPath, enabledPlatforms, allowManagedDomainsOnly and strictAllowlist, docs for the other keys)" },
  "relative-path": { severity: "warning", basis: "binary", what: "a relative bwrapPath or socatPath in managed settings, which Claude Code drops" },
  "platform-name": { severity: "warning", basis: "binary", what: "an enabledPlatforms name that is none of macos, linux, wsl and windows" },
  "protected-path": { severity: "warning", basis: "binary", what: "an allowWrite entry for a path the sandbox keeps write-protected" },
  "write-glob-linux": { severity: "warning", basis: "binary", what: "a wildcard in an allowWrite or denyWrite entry on Linux and WSL2, where the sandbox mounts concrete paths" },
  "domain-empty": { severity: "warning", basis: "binary", what: "an empty allowedDomains or deniedDomains entry" },
  "domain-space": { severity: "warning", basis: "binary", what: "a domain entry with a space at its start or end" },
  "domain-scheme": { severity: "warning", basis: "binary", what: "a domain entry with a scheme (https://github.com)" },
  "domain-path": { severity: "warning", basis: "binary", what: "a domain entry with a path, a query or a user name in it" },
  "domain-port": { severity: "warning", basis: "binary", what: "a domain entry whose port is not 1 to 65535 without a leading zero" },
  "domain-ipv6": { severity: "warning", basis: "binary", what: "an IPv6 domain entry without brackets, which claude doctor calls unreliable" },
  "domain-wildcard": { severity: "warning", basis: "binary", what: "a domain entry with a * that is not the whole first label" },
  "domain-chars": { severity: "warning", basis: "binary", what: "a domain entry with characters a host name does not have" },
  "wildcard-apex": { severity: "note", basis: "binary", what: "*.example.com without example.com, which the wildcard does not match" },
  "inert-here": { severity: "warning", basis: "docs", what: "a key that does something only on another system (enableWeakerNetworkIsolation off macOS, bwrapPath off Linux)" },
  "weaker-nested": { severity: "warning", basis: "binary", what: "enableWeakerNestedSandbox, which mounts the host's /proc and says what that gives up" },
  "mask-in-repository": { severity: "warning", basis: "docs", what: "a credentials mask entry in a project or local file" },
  "dead-entry": { severity: "warning", basis: "binary", what: "an excludedCommands entry that can never take a call out of the sandbox" },
  "bare-entry": { severity: "warning", basis: "binary", what: "an excludedCommands entry with no wildcard, which matches the bare command only" },
  "all-entry": { severity: "warning", basis: "binary", what: "an excludedCommands entry that matches every command" },
  "broad-entry": { severity: "note", basis: "docs", what: "an excludedCommands entry for an interpreter, which lets a script leave the sandbox" },
  "admin-required": { severity: "warning", basis: "binary", what: "a repository's entry or key that an admin-required sandbox ignores" },
  "auto-allow-without-sandbox": { severity: "warning", basis: "binary", what: "autoAllowBashIfSandboxed with no sandbox, which approves nothing" },
  "enabled-unset": { severity: "note", basis: "binary", what: "sandbox keys with no sandbox.enabled anywhere" },
  "retry-held": { severity: "note", basis: "binary", what: "a project's allowUnsandboxedCommands true that a user or managed false holds back" },
  "fail-if-unavailable": { severity: "error", basis: "binary", what: "failIfUnavailable true on a machine where the sandbox cannot start" },
  "no-sandbox-here": { severity: "note", basis: "binary", what: "sandbox.enabled on a system with no Bash sandbox (Windows, WSL1)" },
  "platform-excluded": { severity: "warning", basis: "binary", what: "managed enabledPlatforms that leaves this system out" },
};

const finding = (o) => ({ effect: "none", basis: (RULES[o.id] || {}).basis || "docs", ...o });

/** The place a source points at: { scope, label, display, path, line }. */
const at = (s) => ({ scope: s.scope, label: s.label, display: s.display, file: s.path, line: s.line });

/** A near key name for a typo, or null (edit distance of at most 2). */
function nearKey(key) {
  const names = Object.keys(SANDBOX_KEYS).map((k) => k.split(".").pop());
  const lev = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const tail = key.split(".").pop();
  let best = null;
  for (const n of names) { const d = lev(tail.toLowerCase(), n.toLowerCase()); if (d <= 2 && (best === null || d < best.d)) best = { n, d }; }
  return best ? best.n : null;
}

const PROTECTED_IN_PROJECT = [".claude/settings.json", ".claude/settings.local.json", ".claude/skills", ".claude/agents", ".claude/commands", ".claude/hooks", ".claude/workflows", ".claude/routines", ".claude/output-styles", ".claude/scheduled_tasks.json", ".claude/launch.json", ".claude/loop.md", ".mcp.json", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".gitconfig", ".gitmodules", ".ripgreprc", ".vscode", ".idea", ".git/hooks", ".git/config"];

/** Does a filesystem entry name one of the paths the sandbox keeps write-protected? Returns the protected name or null. */
function protectedPath(entry, isProject) {
  if (typeof entry !== "string") return null;
  let e = entry.replace(/\\/g, "/").replace(/\/\*\*$/, "").replace(/\/+$/, "");
  if (/^~\/\.claude(\/|$)/.test(e) || e === "~/.claude.json" || /^~\/\.claude\.json$/.test(e)) return e;
  if (isProject || e.startsWith("./")) e = e.replace(/^\.\//, "");
  else e = e.replace(/^\.\//, "");
  return PROTECTED_IN_PROJECT.find((p) => e === p || e.endsWith(`/${p}`)) || null;
}

/**
 * Check the settings.
 *   settings  from src/settings.mjs
 *   host      { platform: { id, claude, hasSandbox }, missing: [...], broken } from src/host.mjs (the light check)
 * Returns { findings, counts }.
 */
export function lintSettings(settings, { host, merged } = {}) {
  const platformId = host && host.platform ? host.platform.id : "linux";
  const m = merged || mergeSandbox(settings, { platform: platformId });
  const eff = m.effective;
  const findings = [];
  const add = (f) => findings.push(finding(f));

  // ---- the files -------------------------------------------------------------------------------------------------------
  for (const f of settings.files) {
    if (!f.exists) continue;
    const hasSandboxText = f.text !== undefined && /"sandbox"/.test(f.text);
    if (f.ignored && f.ignored.reason === "not-json" && hasSandboxText) {
      add({ id: "file-ignored", severity: "error", scope: f.scope, file: f.path, display: f.display, line: f.ignored.line, keyPath: "sandbox", effect: "file", message: `Claude Code ignores this whole file, so its sandbox settings do nothing: ${f.ignored.detail}.`, fix: "Make the file strict JSON (no comments, no trailing commas); claude-settings-doctor builds settings.json from a commented settings.jsonc." });
    } else if (f.ignored && f.ignored.reason === "wrong-type") {
      add({ id: "file-ignored", severity: "error", scope: f.scope, file: f.path, display: f.display, line: f.ignored.line, keyPath: "sandbox", effect: "file", message: `Claude Code ignores this whole file, so its sandbox settings do nothing: ${f.ignored.detail} (\`claude doctor\` lists it under Invalid settings).`, fix: "Write the value with the type the message names." });
    }
    const sb = f.view && f.view.sandbox;
    if (!sb) continue;
    for (const u of sb.unknown) {
      const near = nearKey(u.path);
      add({ id: "unknown-key", severity: "warning", scope: f.scope, file: f.path, display: f.display, line: u.line, keyPath: `sandbox.${u.path}`, effect: "key", message: `sandbox.${u.path} is not a sandbox key. Claude Code ignores it without a word (\`claude doctor\` says nothing).${near ? ` Did you mean "${near}"?` : ""}`, fix: near ? `Rename it to ${near}.` : "Remove it." });
    }
    // a key that this file may not set
    for (const [key, e] of Object.entries(sb.entries)) {
      const spec = SANDBOX_KEYS[key];
      if (!spec || !spec.scope || spec.scope === "any") continue;
      const ok = spec.scope === "managed" ? f.scope === "managed" : f.scope === "managed" || f.scope === "user";
      if (ok) continue;
      add({ id: "key-scope", severity: "warning", scope: f.scope, file: f.path, display: f.display, line: e.line, keyPath: `sandbox.${key}`, effect: "key", message: `sandbox.${key} is honored only from ${SCOPE_TEXT[spec.scope]}. Claude Code ignores it in ${f.label}.`, fix: spec.scope === "managed" ? "Set it in managed settings, or remove it." : `Set it in ${f.scope === "project" || f.scope === "local" ? "your user settings" : "user or managed settings"}.`, basis: spec.verified ? "binary" : "docs" });
    }
    // relative bwrapPath and socatPath are dropped
    for (const key of ["bwrapPath", "socatPath"]) {
      const e = sb.entries[key];
      if (e && f.scope === "managed" && typeof e.value === "string" && !/^([/]|[A-Za-z]:[\\/])/.test(e.value)) add({ id: "relative-path", severity: "warning", scope: f.scope, file: f.path, display: f.display, line: e.line, keyPath: `sandbox.${key}`, effect: "key", message: `sandbox.${key} is the relative path ${JSON.stringify(e.value)}. Claude Code drops a relative path and looks for the program on PATH.`, fix: "Write an absolute path." });
    }
    // enabledPlatforms names
    const ep = sb.entries.enabledPlatforms;
    if (ep && Array.isArray(ep.value)) {
      const bad = ep.value.filter((p) => !["macos", "linux", "wsl", "windows"].includes(p));
      if (bad.length) add({ id: "platform-name", severity: "warning", scope: f.scope, file: f.path, display: f.display, line: ep.line, keyPath: "sandbox.enabledPlatforms", effect: "entry", message: `enabledPlatforms names ${bad.map((b) => JSON.stringify(b)).join(", ")}, which is none of macos, linux, wsl and windows, so it never matches a system (\`claude doctor\` says nothing).`, fix: "Use macos, linux, wsl or windows." });
    }
    // allowWrite and denyWrite entries
    for (const key of ["filesystem.allowWrite", "filesystem.denyWrite"]) {
      const e = sb.entries[key];
      if (!e) continue;
      e.items.forEach((it) => {
        if (typeof it.value !== "string") return;
        const clean = it.value.replace(/\/\*\*$/, "");
        if (key === "filesystem.allowWrite") {
          const p = protectedPath(it.value, f.scope === "project" || f.scope === "local");
          if (p) add({ id: "protected-path", severity: "warning", scope: f.scope, file: f.path, display: f.display, line: it.line, keyPath: key, effect: "entry", message: `${JSON.stringify(it.value)} names ${p}, which the sandbox keeps write-protected: an allowWrite entry does not lift that protection.`, fix: "Take the entry out; the only way to write there is filesystem.disabled, which turns off filesystem isolation for every path." });
        }
        if (/[*?[]/.test(clean) && (platformId === "linux" || platformId === "wsl2" || platformId === "wsl1")) add({ id: "write-glob-linux", severity: "warning", scope: f.scope, file: f.path, display: f.display, line: it.line, keyPath: key, effect: "entry", message: `${JSON.stringify(it.value)} has a wildcard. On Linux and WSL2 the sandbox mounts concrete paths, so Claude Code skips an ${key.split(".")[1]} entry with *, ? or [ and it has no effect there (it works on macOS).`, fix: "Write the folder, without the wildcard." });
      });
    }
    // domains
    for (const key of ["network.allowedDomains", "network.deniedDomains"]) {
      const e = sb.entries[key];
      if (!e) continue;
      e.items.forEach((it) => {
        const p = domainProblem(it.value);
        if (p) add({ id: p.code, severity: "warning", scope: f.scope, file: f.path, display: f.display, line: it.line, keyPath: key, effect: "entry", message: `${JSON.stringify(it.value)} ${p.text}.`, fix: p.fix });
        else if (typeof it.value === "string" && /^\*\./.test(it.value)) {
          const apex = it.value.slice(2).replace(/:\d+$/, "");
          const all = (e.items || []).map((x) => x.value);
          if (!all.some((x) => typeof x === "string" && x.replace(/:\d+$/, "") === apex)) add({ id: "wildcard-apex", severity: "note", scope: f.scope, file: f.path, display: f.display, line: it.line, keyPath: key, effect: "none", message: `${JSON.stringify(it.value)} matches the subdomains of ${apex} only, not ${apex} itself.`, fix: `List ${apex} too if you need it.` });
        }
      });
    }
    // settings that do something only on one system
    const here = (keys, where, text) => {
      for (const key of keys) {
        const e = sb.entries[key];
        if (!e || e.value === false || (Array.isArray(e.value) && e.value.length === 0)) continue;
        add({ id: "inert-here", severity: "warning", scope: f.scope, file: f.path, display: f.display, line: e.line, keyPath: `sandbox.${key}`, effect: "key", message: `sandbox.${key} ${text} (this machine: ${host && host.platform ? host.platform.label : platformId}).`, fix: `Remove it, or keep it if the file is shared with ${where}.` });
      }
    };
    if (platformId !== "macos") here(["enableWeakerNetworkIsolation", "allowAppleEvents", "network.allowUnixSockets", "network.allowMachLookup"], "Macs", "only does something on macOS");
    if (platformId === "linux" || platformId === "wsl2" || platformId === "wsl1") here(["network.allowLocalBinding"], "Macs", "only does something on macOS: on Linux and WSL2 a sandboxed command's localhost is private to it");
    if (platformId === "macos" || platformId === "windows") here(["enableWeakerNestedSandbox", "bwrapPath", "socatPath"], "Linux and WSL2", "only does something on Linux and WSL2");
    // weaker nested sandbox
    const wn = sb.entries.enableWeakerNestedSandbox;
    if (wn && wn.value === true) add({ id: "weaker-nested", severity: "warning", scope: f.scope, file: f.path, display: f.display, line: wn.line, keyPath: "sandbox.enableWeakerNestedSandbox", effect: "none", message: "enableWeakerNestedSandbox gives up the fresh /proc mount: the sandbox bind-mounts the container's own /proc, which shows sandboxed commands the container's processes. The docs say to use it only when the outer container already provides the isolation you need.", fix: "Remove it unless Claude Code runs in an unprivileged container (docker, podman) where bubblewrap cannot mount /proc." });
    // credentials mask in a repository file
    const cf = sb.entries["credentials.files"];
    if (cf && (f.scope === "project" || f.scope === "local") && cf.items.some((i) => i.value && i.value.mode === "mask")) add({ id: "mask-in-repository", severity: "warning", scope: f.scope, file: f.path, display: f.display, line: cf.line, keyPath: "sandbox.credentials.files", effect: "entry", message: "A mask entry in a project or local file is dropped by Claude Code (only user, managed and --settings may mask a credential); a deny entry still applies.", fix: "Put the mask entry in your user settings." });
  }

  // ---- excludedCommands ------------------------------------------------------------------------------------------------
  for (const it of m.lists.excludedCommands || []) {
    const sources = it.sources;
    const entry = it.value;
    for (const s of sources) {
      const dead = deadEntryReason(entry);
      const parsed = typeof entry === "string" ? parseContent(entry) : null;
      if (dead) {
        add({ id: "dead-entry", severity: "warning", scope: s.scope, file: s.path, display: s.display, line: s.line, keyPath: "sandbox.excludedCommands", effect: "entry", message: `excludedCommands entry ${JSON.stringify(entry)} can never take a call out of the sandbox: ${dead.text}${dead.sample && dead.sample !== entry ? ` (tried ${JSON.stringify(dead.sample)})` : ""}.`, fix: deadFix(dead.code, entry), reason: dead.code });
      } else if (parsed && parsed.type === "exact" && !/\s/.test(entry.trim()) && entry.trim() !== "") {
        add({ id: "bare-entry", severity: "warning", scope: s.scope, file: s.path, display: s.display, line: s.line, keyPath: "sandbox.excludedCommands", effect: "entry", message: `excludedCommands entry ${JSON.stringify(entry)} has no wildcard, so it matches only the bare command ${JSON.stringify(entry)} with no arguments (docs: "docker matches only docker with no arguments").`, fix: `Write ${JSON.stringify(`${entry} *`)} to match the command with or without arguments.` });
      } else if (parsed && (parsed.type === "wildcard" && /^\*+$/.test(entry.trim()) )) {
        add({ id: "all-entry", severity: "warning", scope: s.scope, file: s.path, display: s.display, line: s.line, keyPath: "sandbox.excludedCommands", effect: "none", message: `excludedCommands entry ${JSON.stringify(entry)} matches every command that can be excluded, so the sandbox is off for them.`, fix: "List the programs that need to leave the sandbox." });
      } else if (typeof entry === "string") {
        const word = entry.trim().split(/\s+/)[0];
        if (INTERPRETERS[word] && /\*|:\*$/.test(entry)) add({ id: "broad-entry", severity: "note", scope: s.scope, file: s.path, display: s.display, line: s.line, keyPath: "sandbox.excludedCommands", effect: "none", message: `excludedCommands entry ${JSON.stringify(entry)} covers an interpreter: Claude can write a script in your working folder and run it outside the sandbox with your full access (docs).`, fix: "Name the one script, or use filesystem.allowWrite or network.allowedDomains to keep the command sandboxed." });
      }
    }
  }
  // entries a repository file holds that an admin-required sandbox ignores
  const ignoredByKey = new Map();
  for (const key of Object.keys(m.lists)) for (const it of m.lists[key]) for (const ig of it.ignored) {
    if (!/admin-required/.test(ig.reason)) continue;
    const k = `${key}|${ig.source.path}`;
    if (!ignoredByKey.has(k)) ignoredByKey.set(k, { key, source: ig.source, reason: ig.reason, items: [] });
    ignoredByKey.get(k).items.push(it.value);
  }
  for (const g of ignoredByKey.values()) {
    add({ id: "admin-required", severity: "warning", scope: g.source.scope, file: g.source.path, display: g.source.display, line: g.source.line, keyPath: `sandbox.${g.key}`, effect: "entry", message: `${g.items.length} ${g.items.length === 1 ? "entry" : "entries"} of sandbox.${g.key} here ${g.items.length === 1 ? "is" : "are"} ignored: ${eff.adminReasons.join("; ")}, which makes the sandbox admin-required, and then a repository's settings cannot add to this list (${g.items.slice(0, 3).map((x) => JSON.stringify(x)).join(", ")}${g.items.length > 3 ? ", ..." : ""}).`, fix: "Put the entries in your user settings or in managed settings." });
  }
  for (const [key, v] of Object.entries(m.values)) for (const s of v.set) {
    if (s.ignored && /admin-required/.test(s.ignored)) add({ id: "admin-required", severity: "warning", scope: s.source.scope, file: s.source.path, display: s.source.display, line: s.source.line, keyPath: `sandbox.${key}`, effect: "key", message: `sandbox.${key} (${JSON.stringify(s.value)}) is ignored here: ${s.ignored}.`, fix: "Set it in your user settings or in managed settings." });
  }

  // ---- enabled, auto-allow, retry, failIfUnavailable -----------------------------------------------------------------------
  const val = (k) => (m.values[k] && m.values[k].winner ? m.values[k] : null);
  const aa = val("autoAllowBashIfSandboxed");
  if (aa && !eff.enabled) add({ id: "auto-allow-without-sandbox", severity: "warning", scope: aa.winner.source.scope, file: aa.winner.source.path, display: aa.winner.source.display, line: aa.winner.source.line, keyPath: "sandbox.autoAllowBashIfSandboxed", effect: "none", message: `autoAllowBashIfSandboxed is ${JSON.stringify(aa.winner.value)}, but ${!eff.enabledInSettings ? "sandbox.enabled is not true in any file that applies" : "managed enabledPlatforms leaves this system out"}: no command is sandboxed, so it approves nothing.`, fix: "Set sandbox.enabled to true, or remove the key." });
  else if (!m.values.enabled) {
    // keys are set and no file says whether the sandbox is on: they do nothing until it is
    for (const f of settings.files) {
      const sb = f.exists && !f.ignored && f.view && f.view.sandbox;
      const key = sb ? Object.keys(sb.entries).find((k) => !["filesystem", "network", "credentials"].includes(k)) : null;
      if (!key) continue;
      add({ id: "enabled-unset", severity: "note", scope: f.scope, file: f.path, display: f.display, line: sb.entries[key].line, keyPath: `sandbox.${key}`, effect: "none", message: "The sandbox block sets keys, but sandbox.enabled is not set in any file that applies, so no command is sandboxed.", fix: 'Set "enabled": true (or run /sandbox).' });
      break;
    }
  }
  const unsandboxed = m.values.allowUnsandboxedCommands;
  if (unsandboxed && unsandboxed.winner && unsandboxed.winner.value === true && eff.strictBy.length) {
    const s = unsandboxed.winner.source;
    if (s.scope === "project" || s.scope === "local") add({ id: "retry-held", severity: "note", scope: s.scope, file: s.path, display: s.display, line: s.line, keyPath: "sandbox.allowUnsandboxedCommands", effect: "key", message: `allowUnsandboxedCommands is true here, but ${eff.strictBy.map((x) => x.display).join(", ")} sets it to false, and a false in user or managed settings holds against a project's true.`, fix: "Remove the true from the repository file." });
  }
  // failIfUnavailable on a machine that cannot start the sandbox
  const fiu = val("failIfUnavailable");
  if (fiu && fiu.winner.value === true && eff.enabled) {
    const s = fiu.winner.source;
    if (host && host.platform && !host.platform.hasSandbox) add({ id: "fail-if-unavailable", severity: "error", scope: s.scope, file: s.path, display: s.display, line: s.line, keyPath: "sandbox.failIfUnavailable", effect: "start", message: `failIfUnavailable is true and this machine (${host.platform.label}) has no Bash sandbox, so Claude Code refuses to start here ("sandbox required but unavailable").`, fix: "Deliver this setting only to Linux, WSL2 and macOS machines, or set failIfUnavailable to false." });
    else if (host && host.missing && host.missing.length) add({ id: "fail-if-unavailable", severity: "error", scope: s.scope, file: s.path, display: s.display, line: s.line, keyPath: "sandbox.failIfUnavailable", effect: "start", message: `failIfUnavailable is true and ${host.missing.join(" and ")} ${host.missing.length === 1 ? "is" : "are"} missing on this machine, so Claude Code refuses to start ("sandbox required but unavailable: ... dependencies are missing").`, fix: host.platform && host.platform.id === "macos" ? "Check that /usr/bin/sandbox-exec is there." : "Install the missing programs: sudo apt-get install bubblewrap socat." });
  }
  if (eff.enabledInSettings && host && host.platform && !host.platform.hasSandbox && !(fiu && fiu.winner.value === true)) {
    const e = val("enabled").winner.source;
    add({ id: "no-sandbox-here", severity: "note", scope: e.scope, file: e.path, display: e.display, line: e.line, keyPath: "sandbox.enabled", effect: "none", message: `sandbox.enabled is true, and this machine (${host.platform.label}) has no Bash sandbox: Claude Code prints "Sandbox disabled" and runs commands without one.`, fix: "Nothing to fix for a file that is shared with Linux and macOS machines." });
  }
  if (!eff.platformListed && eff.enabledInSettings) {
    const ep = m.values.enabledPlatforms;
    const s = ep && ep.winner ? ep.winner.source : null;
    if (s) add({ id: "platform-excluded", severity: "warning", scope: s.scope, file: s.path, display: s.display, line: s.line, keyPath: "sandbox.enabledPlatforms", effect: "key", message: `enabledPlatforms lists ${JSON.stringify(ep.winner.value)} without ${eff.claudePlatform}, so on this system the whole sandbox block is inert: no sandbox, no auto-allow, no warning, no failIfUnavailable exit.`, fix: `Add "${eff.claudePlatform}" to enabledPlatforms.` });
  }

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (b.scope === a.scope ? (a.line || 0) - (b.line || 0) : 0));
  const counts = { error: 0, warning: 0, note: 0 };
  for (const f of findings) counts[f.severity]++;
  return { findings, counts, merged: m };
}

function deadFix(code, entry) {
  switch (code) {
    case "directory": return "cd, pushd and popd are never excluded. Run the command in its own call (Claude Code keeps the working folder from one call to the next).";
    case "wrapper": case "runs-code": case "awk": case "watcher": case "shell-state": case "zsh-builtin": return "Claude Code never takes these out of the sandbox. Use filesystem.allowWrite or network.allowedDomains to give the command what it needs, or exclude the program it runs.";
    case "redirect": return "An entry cannot contain a redirection: Claude Code keeps a call with a redirection to a file sandboxed, whatever the entries say.";
    case "interpreter": case "risky-flag": case "git-flag": case "git-path": case "git-run": case "git-config": return "Claude Code keeps a call with that flag sandboxed. Exclude the command without the flag, or use filesystem.allowWrite or network.allowedDomains.";
    case "unsafe-assignment": return "A variable set in front of the command is not stepped over, except a few harmless ones (NODE_ENV, CI, LANG, ...). Drop the assignment from the entry.";
    case "command-word": return "Write the program name plainly: no quotes, variables or wildcards in the first word.";
    case "empty": return "Remove the entry.";
    default: return "Rewrite the entry so that a plain call of the program matches it.";
  }
}
