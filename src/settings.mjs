// Find and read every settings file that applies to a project, for the parts this tool is about: the `sandbox` block and the
// `permissions` entries that reach the sandbox (the read block, Read and Edit rules, WebFetch domain rules, extra folders).
//
// The files and their order come from claude-permission-doctor's loader (src/engine/settings.mjs, copied unchanged), and the
// reading of the text, with the line of each key, from claude-settings-doctor's. Highest precedence first:
//   managed   managed-settings.json (+ managed-settings.d/*.json) in the system folder. Server-managed settings, macOS
//             profiles and the Windows registry are not files and are not read.
//   local     <project>/.claude/settings.local.json
//   project   <project>/.claude/settings.json
//   user      <config folder>/settings.json, where the config folder is $CLAUDE_CONFIG_DIR or ~/.claude
// The --settings flag of Claude Code is a fifth source that this tool cannot see.
//
// Nothing here writes. Claude Code ignores a settings file that is not strict JSON (a comment or a trailing comma is enough),
// and also one that has a value of the wrong type in the sandbox block (`claude doctor` says "Expected boolean, but received
// string" and the setting does not apply; put to Claude Code 2.1.299). Such a file is kept in the list, marked ignored, and
// left out of everything that is merged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMember, parseJsonc, positionAt, toValue } from "./jsonc.mjs";
import { loadSettings as loadRules, configDir, managedDir, gitRoot, localSettingsPaths, shortPath, SCOPES } from "./engine/settings.mjs";
import { SANDBOX_KEYS } from "./facts.mjs";

export { configDir, managedDir, gitRoot, localSettingsPaths, shortPath, SCOPES };

const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/**
 * Read a settings text the way Claude Code does, and say what is wrong with it.
 * Returns { empty, parse, data, problems, ignored }:
 *   data      the settings object when Claude Code would load the text, else null
 *   problems  [{ kind: "syntax" | "comment" | "trailing-comma" | "not-object", message, line }]
 */
export function analyzeText(text) {
  const parse = parseJsonc(text);
  const out = { empty: false, parse, data: null, problems: [], ignored: false };
  if (stripBom(text).trim() === "") { out.empty = true; out.data = {}; return out; }
  const at = (offset) => positionAt(text, offset);
  if (!parse.ok) {
    out.problems.push({ kind: "syntax", message: parse.error.message, line: at(parse.error.offset).line });
  } else {
    if (parse.comments.length) out.problems.push({ kind: "comment", message: `a comment (${parse.comments[0].kind === "line" ? "//" : "/* */"}), which JSON does not have`, line: at(parse.comments[0].start).line });
    if (parse.trailingCommas.length) out.problems.push({ kind: "trailing-comma", message: "a trailing comma, which JSON does not allow", line: at(parse.trailingCommas[0]).line });
  }
  if (out.problems.length === 0) {
    let data;
    try { data = JSON.parse(stripBom(text)); } catch (e) { out.problems.push({ kind: "syntax", message: String(e.message).replace(/\s+/g, " ").slice(0, 140), line: 1 }); }
    if (out.problems.length === 0) {
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        const what = data === null ? "null" : Array.isArray(data) ? "a list" : typeof data === "string" ? "a string" : typeof data === "number" ? "a number" : "a boolean";
        out.problems.push({ kind: "not-object", message: `the file holds ${what}, and Claude Code wants an object ({ ... })`, line: 1 });
      } else out.data = data;
    }
  }
  out.ignored = out.problems.length > 0;
  return out;
}

const RANK = { managed: 40, local: 30, project: 20, user: 10 };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Does a value have the type the key wants? (the types of the schema; Claude Code takes nothing else) */
function typeOk(type, v) {
  switch (type) {
    case "boolean": return typeof v === "boolean";
    case "string": return typeof v === "string";
    case "strings": return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "objects": return Array.isArray(v) && v.every(isObj);
    case "object": return isObj(v);
    case "port": return Number.isInteger(v);
    default: return true;
  }
}
const WANT = { boolean: "boolean", string: "string", strings: "array of strings", objects: "array of objects", object: "object", port: "integer" };

/** The sandbox block of one file: its keys with their lines, the keys Claude Code does not know, the values of the wrong type. */
function sandboxView(root, text) {
  const line = (offset) => positionAt(text, offset).line;
  const sb = findMember(root, "sandbox");
  if (!sb) return null;
  const view = { present: true, line: line(sb.start), wrongType: !isObj(toValue(sb.value)), entries: {}, unknown: [], problems: [] };
  if (view.wrongType) {
    view.problems.push({ path: ["sandbox"], kind: "wrong-type", fatal: true, line: view.line, message: `sandbox is ${typeName(toValue(sb.value))}, and Claude Code wants an object` });
    return view;
  }
  const itemsOf = (node) => (node && node.type === "array" ? node.items.map((n, index) => ({ index, line: line(n.start), value: toValue(n) })) : []);
  const add = (keyPath, member) => {
    const value = toValue(member.value);
    const e = { path: keyPath, line: line(member.start), value, items: itemsOf(member.value) };
    view.entries[keyPath] = e;
    const spec = SANDBOX_KEYS[keyPath];
    if (spec && spec.type !== "any" && !typeOk(spec.type, value)) {
      view.problems.push({ path: ["sandbox", ...keyPath.split(".")], kind: "wrong-type", fatal: true, line: e.line, message: `sandbox.${keyPath} is ${typeName(value)}, and Claude Code wants ${WANT[spec.type] || spec.type}` });
    }
    return e;
  };
  for (const m of sb.value.members) {
    const key = m.key;
    if (!(key in SANDBOX_KEYS)) { view.unknown.push({ path: key, line: line(m.start) }); continue; }
    add(key, m);
    if ((key === "filesystem" || key === "network" || key === "credentials") && m.value.type === "object") {
      for (const n of m.value.members) {
        const sub = `${key}.${n.key}`;
        if (!(sub in SANDBOX_KEYS)) { view.unknown.push({ path: sub, line: line(n.start) }); continue; }
        add(sub, n);
      }
    }
  }
  return view;
}

/** The lines, rules and values of one file that this tool looks at, with the line of each. */
function viewOf(file) {
  const view = { sandbox: null, permissions: null, problems: [] };
  const root = file.analysis && file.analysis.parse && file.analysis.parse.root;
  // a file with a comment is ignored by Claude Code, but it is still read here, so that a finding can say what the file
  // would have said; whatever merges leaves out every ignored file
  if (!file.analysis || !root || root.type !== "object") return view;
  const text = file.text;
  const line = (offset) => positionAt(text, offset).line;
  const itemsOf = (node) => (node && node.type === "array" ? node.items.map((n, index) => ({ index, line: line(n.start), value: n.type === "string" || n.type === "literal" || n.type === "number" ? n.value : toValue(n) })) : []);

  view.sandbox = sandboxView(root, text);
  if (view.sandbox) for (const p of view.sandbox.problems) if (p.fatal) view.problems.push(p);

  const pm = findMember(root, "permissions");
  if (pm && pm.value.type === "object") {
    const perm = { present: true, line: line(pm.start), allow: [], ask: [], deny: [], defaultMode: null, blockReads: null, additionalDirectories: [] };
    for (const behavior of ["allow", "ask", "deny"]) {
      const m = findMember(pm.value, behavior);
      if (m) perm[behavior] = itemsOf(m.value).filter((i) => typeof i.value === "string").map((i) => ({ raw: i.value, line: i.line, index: i.index }));
    }
    const dm = findMember(pm.value, "defaultMode");
    if (dm) perm.defaultMode = { value: toValue(dm.value), line: line(dm.start) };
    const br = findMember(pm.value, "blockReadsOutsideWorkingDirectories");
    if (br) {
      perm.blockReads = { value: toValue(br.value), line: line(br.start) };
      if (typeof perm.blockReads.value !== "boolean") view.problems.push({ path: ["permissions", "blockReadsOutsideWorkingDirectories"], kind: "wrong-type", fatal: true, line: perm.blockReads.line, message: "permissions.blockReadsOutsideWorkingDirectories must be true or false" });
    }
    const dirs = findMember(pm.value, "additionalDirectories");
    if (dirs) perm.additionalDirectories = itemsOf(dirs.value).filter((i) => typeof i.value === "string").map((i) => ({ value: i.value, line: i.line }));
    view.permissions = perm;
  }
  return view;
}

/**
 * Read all settings files that apply.
 *   project   the folder Claude Code starts in
 *   env, home, platform   injectable so tests never touch the real machine
 *   managed   the folder searched for managed settings (tests); else $CLAUDE_SANDBOX_DOCTOR_MANAGED_DIR, else the system folder
 * Returns the engine's settings object (configDir, project, home, files, rules, additionalDirectories, notes, managedOnly)
 * with these additions on every file: display, rank, analysis, view, ignored ({ reason, detail, line } or null), and
 * `files` sorted highest precedence first. The rules of an ignored file are left out of `rules`.
 */
export function loadSettings({ project, env = process.env, home = os.homedir(), platform = process.platform, managed } = {}) {
  const mdir = managed || env.CLAUDE_SANDBOX_DOCTOR_MANAGED_DIR || managedDir(platform);
  const base = loadRules({ project, env, home, platform, managed: mdir });
  const proj = base.project;
  let dropIn = 0;
  let localN = 0;
  for (const f of base.files) {
    f.display = shortPath(f.path, { home, project: proj });
    if (f.scope === "managed") f.rank = f.label === "managed settings" ? RANK.managed : RANK.managed + 1 + dropIn++;
    else if (f.scope === "local") f.rank = RANK.local - localN++;
    else f.rank = RANK[f.scope];
    f.analysis = f.exists && f.text !== undefined ? analyzeText(f.text) : null;
    f.view = viewOf(f);
    f.ignored = null;
    if (f.analysis && f.analysis.ignored) f.ignored = { reason: "not-json", detail: f.analysis.problems[0].message, line: f.analysis.problems[0].line };
    else if (f.view.problems.length) f.ignored = { reason: "wrong-type", detail: f.view.problems[0].message, line: f.view.problems[0].line };
    if (f.ignored) f.data = null; // the view keeps the lines, so a finding can say where the wrong value is
  }
  base.files.sort((a, b) => b.rank - a.rank);
  // a file Claude Code ignores contributes no rules, no directories and no sandbox keys
  const gone = new Set(base.files.filter((f) => f.ignored).map((f) => f.path));
  if (gone.size) {
    base.rules = base.rules.filter((r) => !gone.has(r.file));
    base.additionalDirectories = base.files.filter((f) => !f.ignored && f.additionalDirectories).flatMap((f) => f.additionalDirectories.map((d) => resolveDirFor(d, f, base)));
    base.managedOnly = base.files.some((f) => !f.ignored && f.scope === "managed" && f.data && f.data.allowManagedPermissionRulesOnly === true);
    for (const r of base.rules) if (base.managedOnly && r.scope !== "managed") r.ignored = "allowManagedPermissionRulesOnly"; else delete r.ignored;
  }
  base.platform = platform;
  return base;
}

function resolveDirFor(d, file, { configDir: cfgDir, project, home }) {
  if (d === "~" || d.startsWith("~/") || d.startsWith("~\\")) return path.join(home, d.slice(1));
  if (d.startsWith("//")) return path.resolve(d.slice(1));
  return path.resolve(file.scope === "user" ? cfgDir : project, d);
}

/** Read a file the way the CLI is asked to: undefined when it is not there. */
export function readIfThere(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
}
