// The merged `sandbox` settings: for every key the value that wins, the file it came from, what it shadows, which entries of a
// list come from which file, and which entries Claude Code leaves out (a key that only user or managed settings may set,
// and what an admin-required sandbox ignores in a repository's files). The rules are the documentation's
// (sandboxing.md, "Keep developers from widening the policy" and "Repository settings under an admin-required sandbox";
// settings-reference.md, the Scope line of each key); the README says which of them were put to the binary.
//
// Precedence of the files that exist: managed, local, project, user. A plain value is the one the highest file sets. A list is
// the items of every file that may set it, joined, an item twice counted once. `--settings` is a source this tool cannot see.
import { LIST_KEYS, LOOSENING_FLAGS, LOOSENING_LISTS, PLATFORMS, SANDBOX_KEYS, SCALAR_KEYS } from "./facts.mjs";

const REPO = new Set(["project", "local"]);

/** { scope, label, display, path, rank, line } of the place a value came from. */
const sourceOf = (f, line) => ({ scope: f.scope, label: f.label, display: f.display, path: f.path, rank: f.rank, line: line || null });

/** Which settings names the platform has in `enabledPlatforms`: macOS "macos", Linux "linux", WSL "wsl", Windows "windows". */
export const claudePlatform = (id) => ({ linux: "linux", wsl2: "wsl", wsl1: "wsl", macos: "macos", windows: "windows" }[id] || id);

/** Does a file of this scope get to set this key? */
export function honoredFrom(key, scope) {
  const spec = SANDBOX_KEYS[key];
  if (!spec || !spec.scope || spec.scope === "any") return true;
  if (spec.scope === "user") return scope === "managed" || scope === "user";
  if (spec.scope === "managed") return scope === "managed";
  return true;
}

const firstValue = (entries) => (entries.length ? entries[0].value : undefined);

/**
 * Merge the sandbox keys of the settings files.
 *   settings   the object src/settings.mjs gives
 *   platform   "linux" | "wsl2" | "wsl1" | "macos" | "windows": the system this is about
 * Returns { present, files, values, lists, effective, notes, derived }:
 *   values[key]   { key, winner: {value, source}, set: [{ value, source, ignored? }] } for the plain keys
 *   lists[key]    [{ value, sources: [source], ignored: [{source, reason}] }] for the list keys: the items Claude Code uses
 *                 have an empty `ignored`; an item only an ignored file holds has no `sources`
 *   effective     what the keys add up to (see the end of this function)
 */
export function mergeSandbox(settings, { platform = "linux" } = {}) {
  const files = settings.files.filter((f) => f.exists);
  const live = files.filter((f) => !f.ignored); // the files whose settings apply, highest first
  const rows = (key) => {
    const out = [];
    for (const f of files) {
      const e = f.view && f.view.sandbox && f.view.sandbox.entries[key];
      if (!e) continue;
      out.push({ file: f, entry: e, value: e.value, source: sourceOf(f, e.line), ignoredFile: Boolean(f.ignored) });
    }
    return out;
  };

  const managedFiles = live.filter((f) => f.scope === "managed");
  const managedHas = (key) => managedFiles.map((f) => f.view.sandbox && f.view.sandbox.entries[key]).filter(Boolean);
  // the sandbox is admin-required while managed settings forbid the retry or lock the domains (docs; the --settings flag also
  // does, which this tool cannot see)
  const adminReasons = [];
  const mUnsandboxed = managedHas("allowUnsandboxedCommands").find((e) => e.value === false);
  if (mUnsandboxed) adminReasons.push("managed settings set allowUnsandboxedCommands to false");
  const mDomains = managedHas("network.allowManagedDomainsOnly").find((e) => e.value === true);
  if (mDomains) adminReasons.push("managed settings set network.allowManagedDomainsOnly to true");
  const adminRequired = adminReasons.length > 0;

  // does a file contribute this key? returns null or the reason it does not
  const skipReason = (key, f, value) => {
    if (f.ignored) return `Claude Code ignores this file (${f.ignored.detail})`;
    if (!honoredFrom(key, f.scope)) return `only ${SANDBOX_KEYS[key].scope === "managed" ? "managed settings" : "user settings, managed settings and --settings"} set this key`;
    if (adminRequired && REPO.has(f.scope)) {
      if (LOOSENING_LISTS.includes(key)) return "the sandbox is admin-required, and a repository's file cannot add to this list";
      if (LOOSENING_FLAGS.includes(key) && value === true) return "the sandbox is admin-required, and a repository's file cannot turn this on";
    }
    return null;
  };

  const values = {};
  for (const key of SCALAR_KEYS) {
    const all = rows(key);
    if (!all.length) continue;
    const set = all.map((r) => ({ value: r.value, source: r.source, ignored: skipReason(key, r.file, r.value) }));
    // under an admin-required sandbox `enabled` and `failIfUnavailable` set to false in a repository's file lose to a `true` in the user's file
    if (adminRequired && (key === "enabled" || key === "failIfUnavailable")) {
      const userTrue = set.some((s) => s.source.scope === "user" && !s.ignored && s.value === true);
      if (userTrue) for (const s of set) if (REPO.has(s.source.scope) && s.value === false && !s.ignored) s.ignored = "the sandbox is admin-required, and the user's settings set this to true";
    }
    const used = set.filter((s) => !s.ignored);
    values[key] = { key, winner: used.length ? used[0] : null, set, shadowed: used.slice(1).filter((s) => JSON.stringify(s.value) !== JSON.stringify(used[0].value)) };
  }
  // objects that are merged key by key (ignoreViolations) are shown as one value
  {
    const all = rows("ignoreViolations");
    if (all.length) {
      const set = all.map((r) => ({ value: r.value, source: r.source, ignored: skipReason("ignoreViolations", r.file, r.value) }));
      const used = set.filter((s) => !s.ignored);
      values.ignoreViolations = { key: "ignoreViolations", winner: used.length ? used[0] : null, set, shadowed: [] };
    }
  }

  const lists = {};
  for (const key of LIST_KEYS) {
    if (key === "enabledPlatforms") continue; // managed only, shown as a plain value below
    const items = new Map();
    let any = false;
    for (const r of rows(key)) {
      any = true;
      const reason = skipReason(key, r.file, r.value);
      const arr = Array.isArray(r.value) ? r.value : [];
      arr.forEach((v, index) => {
        const k = typeof v === "string" ? v : JSON.stringify(v);
        let it = items.get(k);
        if (!it) { it = { value: v, sources: [], ignored: [] }; items.set(k, it); }
        const line = r.entry.items[index] ? r.entry.items[index].line : r.entry.line;
        if (reason) it.ignored.push({ source: sourceOf(r.file, line), reason });
        else it.sources.push(sourceOf(r.file, line));
      });
    }
    if (any) lists[key] = [...items.values()];
  }
  // enabledPlatforms is only read from managed settings
  {
    const all = rows("enabledPlatforms");
    if (all.length) {
      const set = all.map((r) => ({ value: r.value, source: r.source, ignored: skipReason("enabledPlatforms", r.file, r.value) }));
      const used = set.filter((s) => !s.ignored);
      values.enabledPlatforms = { key: "enabledPlatforms", winner: used.length ? used[0] : null, set, shadowed: [] };
    }
  }

  // ---- what the keys add up to -----------------------------------------------------------------------------------------
  const val = (key) => (values[key] && values[key].winner ? values[key].winner.value : undefined);
  const claude = claudePlatform(platform);
  const enabledPlatforms = val("enabledPlatforms");
  const platformListed = !Array.isArray(enabledPlatforms) ? true : enabledPlatforms.includes(claude);
  const enabledInSettings = val("enabled") === true;
  const trustedUnsandboxed = [...managedFiles, ...live.filter((f) => f.scope === "user")].map((f) => f.view.sandbox && f.view.sandbox.entries.allowUnsandboxedCommands).filter((e) => e && typeof e.value === "boolean")[0];
  const winnerUnsandboxed = val("allowUnsandboxedCommands");
  const strictBy = [];
  if (winnerUnsandboxed === false) strictBy.push(values.allowUnsandboxedCommands.winner.source);
  if (trustedUnsandboxed && trustedUnsandboxed.value === false) {
    const src = [...managedFiles, ...live.filter((f) => f.scope === "user")].find((f) => f.view.sandbox && f.view.sandbox.entries.allowUnsandboxedCommands === trustedUnsandboxed);
    if (src && !strictBy.some((s) => s.path === src.path)) strictBy.push(sourceOf(src, trustedUnsandboxed.line));
  }
  const excluded = (lists.excludedCommands || []).filter((it) => it.sources.length > 0);
  const effective = {
    platform, claudePlatform: claude,
    enabledInSettings,
    platformListed,
    enabled: enabledInSettings && platformListed,
    failIfUnavailable: val("failIfUnavailable") === true,
    autoAllowBashIfSandboxed: val("autoAllowBashIfSandboxed") !== false,
    allowUnsandboxedCommands: strictBy.length === 0,
    strictBy,
    adminRequired,
    adminReasons,
    excludedCommands: excluded.map((it) => ({ value: it.value, sources: it.sources })),
    ignoredExcluded: (lists.excludedCommands || []).filter((it) => it.sources.length === 0).map((it) => ({ value: it.value, ignored: it.ignored })),
    blockReads: blockReadsOf(settings),
  };

  const notes = [];
  if (!platformListed) notes.push(`managed settings list enabledPlatforms ${JSON.stringify(enabledPlatforms)} without ${claude}: on this system the sandbox settings do nothing (no sandbox, no auto-allow, no warning, no failIfUnavailable exit)`);
  if (adminRequired) notes.push(`the sandbox is admin-required (${adminReasons.join("; ")}): the settings that loosen it are taken only from managed settings, --settings and the user's own file`);
  if (winnerUnsandboxed === true && strictBy.length) notes.push("allowUnsandboxedCommands is true in a repository's file, and false in user or managed settings, which wins");

  return { present: files.some((f) => f.view && f.view.sandbox), files: files.map((f) => ({ scope: f.scope, label: f.label, display: f.display, path: f.path, rank: f.rank, ignored: f.ignored, sandboxKeys: f.view && f.view.sandbox ? Object.keys(f.view.sandbox.entries).length : 0 })), values, lists, effective, notes, derived: derivedFromPermissions(settings) };
}

/** permissions.blockReadsOutsideWorkingDirectories: true when any file that applies sets true (a false is the same as unset). */
export function blockReadsOf(settings) {
  const on = [];
  for (const f of settings.files) {
    if (!f.exists || f.ignored) continue;
    const p = f.view && f.view.permissions;
    if (p && p.blockReads && p.blockReads.value === true) on.push(sourceOf(f, p.blockReads.line));
  }
  return { on: on.length > 0, sources: on };
}

/**
 * What Claude Code adds to the sandbox's lists from permission rules (docs: Edit allow rules to allowWrite, Edit deny rules to
 * denyWrite, Read deny rules to denyRead, WebFetch(domain:...) allow and deny rules to the domain lists), and the extra
 * folders that sandboxed commands may write to.
 */
export function derivedFromPermissions(settings) {
  const out = { allowWrite: [], denyWrite: [], denyRead: [], allowedDomains: [], deniedDomains: [], additionalDirectories: [] };
  for (const r of settings.rules || []) {
    if (r.problem || r.ignored || r.content === undefined) continue;
    const file = settings.files.find((f) => f.path === r.file);
    const src = { scope: r.scope, label: r.label, display: file ? file.display : r.file, path: r.file, line: findLine(file, r) };
    const item = { rule: r.raw, content: r.content, source: src };
    if (r.tool === "Edit") (r.behavior === "allow" ? out.allowWrite : r.behavior === "deny" ? out.denyWrite : []).push(item);
    else if (r.tool === "Read" && r.behavior === "deny") out.denyRead.push(item);
    else if (r.tool === "WebFetch" && /^domain:/.test(r.content)) {
      const d = { ...item, content: r.content.replace(/^domain:/, "") };
      if (r.behavior === "allow") out.allowedDomains.push(d);
      else if (r.behavior === "deny") out.deniedDomains.push(d);
    }
  }
  for (const f of settings.files) {
    if (!f.exists || f.ignored) continue;
    const p = f.view && f.view.permissions;
    if (p) for (const d of p.additionalDirectories) out.additionalDirectories.push({ value: d.value, source: sourceOf(f, d.line) });
  }
  return out;
}

function findLine(file, rule) {
  const p = file && file.view && file.view.permissions;
  if (!p) return null;
  const it = (p[rule.behavior] || []).find((x) => x.index === rule.index);
  return it ? it.line : null;
}

export { PLATFORMS };
