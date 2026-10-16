// Does a Bash call leave the sandbox because of `sandbox.excludedCommands`, and if it does not, why not?
//
// Claude Code checks the entries against each call (a call is the whole line Claude sends). The call is read into its simple
// commands; if the line has a shape Claude Code does not take apart (a command substitution, a subshell, a control-flow block,
// a redirection to a file, ...) the whole call stays sandboxed. Otherwise every simple command is looked at: it must be
// covered by an entry, and some commands can never be covered (cd, sudo, eval, a shell given -c, git given -C ...). One part
// that is not covered keeps the whole call in the sandbox. The rules are the documentation's, read against the code of Claude
// Code 2.1.299 and put to the binary in CI (test/why-table.mjs: every row of it is run against the real thing).
//
// The command is read with claude-permission-doctor's reader (src/engine/shell.mjs), which was checked against the binary's
// reading of a command for permission rules. This file is the part that is about the sandbox.
import { parseBash } from "./engine/shell.mjs";
import { parseContent, matches } from "./engine/pattern.mjs";
import { wrapperLength } from "./engine/wrappers.mjs";
import { GIT_PATH_FORMS, INTERPRETERS, LOOKED_THROUGH, MAX_CALL_CHARS, RISKY_FLAGS, SAFE_ENV, STAYS_SANDBOXED } from "./facts.mjs";

/** Every reason a call or a part can stay sandboxed: the id (stable, in --json) and what it says. */
export const REASONS = {
  // the whole call
  "too-long": "the call is longer than 10,000 characters, which Claude Code does not take apart",
  "unusual-text": "the call has a control character, a lone surrogate, a backslash before a line break, `~[`, `=word` or `<1-5>`, which Claude Code does not read as plain shell",
  "unparseable": "Claude Code cannot read the call as shell",
  "substitution": "a command substitution ($( ), backticks, ${ ; }) or an arithmetic expansion: Claude Code keeps the whole call sandboxed",
  "process-substitution": "a process substitution <( ) or >( ): Claude Code keeps the whole call sandboxed",
  "subshell": "a subshell ( ): Claude Code keeps the whole call sandboxed",
  "group": "a group in braces or double parentheses: Claude Code keeps the whole call sandboxed",
  "control-flow": "an if, for, while, until or select block: Claude Code keeps the whole call sandboxed",
  "function": "a function definition or coproc: Claude Code keeps the whole call sandboxed",
  "case": "a case statement: Claude Code keeps the whole call sandboxed",
  "test-brackets": "a test in [ ] or [[ ]]: Claude Code keeps the whole call sandboxed",
  "redirect": "a redirection to or from a file or a here-document (only one that copies a file descriptor, such as 2>&1, is allowed): Claude Code keeps the whole call sandboxed",
  "variable-flow": "a variable is set in one part of the call and used in another",
  "quote-trick": "a $\"...\" string or a brace expansion with a quote in it",
  // one part of the call
  "empty": "there is nothing to match",
  "directory": "cd, chdir, pushd and popd are never excluded, wherever they are in the call",
  "wrapper": "a command that runs another command (sudo, doas, su, xargs, sed, command, builtin, ...) is never excluded",
  "runs-code": "a builtin that runs or defines code (eval, source, exec, trap, alias, ...) is never excluded",
  "awk": "awk can run commands, so it is never excluded",
  "watcher": "watch, strace, flock, unshare and the like run another program and are never excluded",
  "shell-state": "a builtin that sets variables or shell options (export, declare, set, shift, read, ...) is never excluded",
  "zsh-builtin": "a zsh builtin that can run code or change the shell is never excluded",
  "unsafe-assignment": "a variable is assigned in front of the command, and only a short list of harmless ones (NODE_ENV, LANG, CI, ...) is looked through",
  "command-word": "the command word has a variable, quote, backslash, glob or backtick in it",
  "leading-dash": "the part starts with a dash",
  "env": "env is looked through only as plain `env`, `/bin/env` or `/usr/bin/env`, with at most -i, -0 and -u NAME",
  "ifs": "the part uses $IFS",
  "unusual-space": "the call has a space character that is not a plain space or tab",
  "unlooked-wrapper": "a wrapper such as timeout, nice or stdbuf has arguments Claude Code does not read",
  "interpreter": "a shell or interpreter given a flag that runs code (-c, -e, --eval, ...), or reading its program from input",
  "risky-flag": "a flag that points the program somewhere else or runs code (docker -H, kubectl --server, aws --profile, ...)",
  "git-flag": "git given -c, -C, --git-dir, --work-tree, --exec-path or another flag that changes where it runs or what it runs",
  "git-path": "git clone, init, worktree add or move, bundle create with a path that is absolute, starts with ~ or $, or has a .. segment",
  "git-run": "git bisect run, submodule foreach, hook run: they run another command",
  "git-config": "git config with a key that runs code (alias.*, core.sshCommand, core.pager, ...)",
  "pipe-stage": "make, at, ed, sqlite and crontab read their program from input, so after a pipe they are never excluded",
  "arg-expansion": "an argument of this program has a variable or substitution in it",
  "no-entry": "no entry of excludedCommands matches this part",
};

const REDIRECT_FD_DUP = /^(?:\d+)?>&\d*-?$|^<&\d*-?$/;

/** A redirection that only copies a file descriptor (2>&1) does not keep a call sandboxed; any other does. */
const isDescriptorCopy = (r) => (r.op === ">&" || r.op === "<&") && r.target && /^\d+$/.test(r.target.value) && !r.heredoc && (r.fd === null || /^\d+$/.test(String(r.fd)));

const COUNTED_ISSUES = {
  "substitution": "substitution",
  "quoted-substitution": "substitution",
  "process-substitution": "process-substitution",
  "subshell": "subshell",
  "brace-group": "group",
  "function": "function",
  "case": "case",
  "test-brackets": "test-brackets",
};

/** The basename of a command word the way Claude Code reads it: the last path segment, lower case, .exe cut, a version number cut. */
export function programName(word) {
  const alias = { nodejs: "node", genv: "env", gtimeout: "timeout", gnice: "nice", gnohup: "nohup", gstdbuf: "stdbuf", gtime: "time", gsed: "sed", gawk: "awk", gxargs: "xargs", gmake: "make", "bash-static": "bash", "pwsh-preview": "pwsh", "zsh-static": "zsh", "mksh-static": "mksh", "static-sh": "sh" };
  const cut = (s, re) => { const r = s.replace(re, ""); return r.length > 0 ? r : s; };
  let n = (String(word).split(/[/\\]/).pop() || "").toLowerCase();
  n = cut(n, /[. ]+$/);
  n = cut(n, /\.(?:exe|com|bat|cmd)$/);
  if (Object.prototype.hasOwnProperty.call(alias, n)) return alias[n];
  for (;;) {
    const s = cut(n, /-?[0-9]+(?:\.[0-9]+)*$/);
    if (s === n) break;
    n = s;
  }
  return Object.prototype.hasOwnProperty.call(alias, n) ? alias[n] : n;
}

/** The reason a first word can never be covered, or null. `word` is as written, `name` its program name. */
export function neverCovered(word) {
  const name = programName(word);
  const S = STAYS_SANDBOXED;
  if (S.runs.has(word)) return "runs-code";
  if (S.awk.has(name)) return "awk";
  if (S.watchers.has(name)) return "watcher";
  if (S.variables.has(word)) return "shell-state";
  if (S.zsh.has(word)) return "zsh-builtin";
  if (S.wrappers.has(name)) return "wrapper";
  if (S.directory.has(word)) return "directory";
  return null;
}

// ---- the parts -----------------------------------------------------------------------------------------------------------

const wordsOf = (text) => [...String(text).matchAll(/[^ \t]+/g)].map((m) => ({ text: m[0], index: m.index }));
const stripWords = (text, k) => { const w = wordsOf(text); return k >= w.length ? "" : text.slice(w[k].index); };

/** Leading NAME=value words of a text whose NAME is on the harmless list are stepped over. */
function stepOverAssignments(text) {
  let t = text;
  for (;;) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\'"])*[ \t]+/.exec(t);
    if (!m || !SAFE_ENV.has(m[1])) return t;
    t = t.slice(m[0].length);
  }
}

const TRUSTED_ENV = new Set(["env", "/bin/env", "/usr/bin/env"]);
const envKind = (word) => (programName(word) !== "env" ? "none" : TRUSTED_ENV.has(word.replace(/\/+/g, "/")) ? "trusted" : "untrusted");

/** `env`, `env -i`, `env -0`, `env -u NAME` in front of a command are stepped over when env is the plain one. */
function stepOverEnv(text) {
  let t = text;
  const first = wordsOf(t)[0];
  if (!first || envKind(first.text) !== "trusted") return t;
  t = t.slice(first.text.length).replace(/^[ \t]+/, "");
  for (;;) {
    const n = t.replace(/^(?:-i|--ignore-environment|-0|--null)[ \t]+|^(?:-u[ \t]+|--unset=)[A-Za-z_][A-Za-z0-9_]*[ \t]+/, "");
    if (n === t) return t;
    t = n;
  }
}

// The wrappers Claude Code steps over, as the shapes it accepts (put to the binary: `time -p docker ps` is not one of them, `time
// docker ps` is; the number is the duration of timeout):
//   timeout [--foreground|--preserve-status|--verbose|-v|--kill-after=X|--signal=X|--kill-after X|--signal X|-k X|-s X|-kX|-sX]... [--] 5s
//   time [--]      nice [-n N | -N] [--]      stdbuf -oL [-eL ...] [--]      nohup [--]
const WORD = "[A-Za-z0-9_.+-]+";
const WRAPPERS = [
  new RegExp(`^timeout[ \\t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=${WORD}|--(?:kill-after|signal)[ \\t]+${WORD}|-v|-[ks][ \\t]+${WORD}|-[ks]${WORD})[ \\t]+)*(?:--[ \\t]+)?\\d+(?:\\.\\d+)?[smhd]?[ \\t]+`),
  /^time[ \t]+(?:--[ \t]+)?/,
  /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
  /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
  /^nohup[ \t]+(?:--[ \t]+)?/,
];

/** The text after one wrapper, or null when the text does not start with one that Claude Code reads. */
function stepOverWrapper(text) {
  for (const re of WRAPPERS) {
    const m = re.exec(text);
    if (m) return text.slice(m[0].length);
  }
  return null;
}

/** Strip, in turn, harmless assignments, a plain env, and timeout, time, nice, stdbuf and nohup. Returns { text, prefix }. */
export function normalizePart(part) {
  let text = part.trim();
  let prefix = "";
  for (let guard = 0; guard < 20; guard++) {
    const before = text;
    text = stepOverAssignments(text);
    text = stepOverEnv(text);
    const rest = stepOverWrapper(text);
    if (rest !== null && rest.trim() !== "") {
      prefix += text.slice(0, text.length - rest.length);
      text = rest;
    }
    if (text === before) break;
  }
  return { text, prefix };
}

/** The text a part is matched against, with each form that Claude Code tries: the call's part as written, then stripped. */
function candidatesFor(part, normalized) {
  const out = [];
  const add = (t) => { if (t && !out.includes(t)) out.push(t); };
  add(normalized.text);
  if (normalized.prefix) add(`${normalized.prefix}${normalized.text}`);
  return out;
}

/** Is this word one that takes the flag? Short flags can carry their value (-cfoo) or share a word (-ec). */
function hasFlag(args, flag, takesValueLetters = []) {
  return args.some((a) => {
    if (a === flag || a.startsWith(`${flag}=`)) return true;
    if (flag.startsWith("--") || flag.length !== 2) return false;
    if (a.startsWith("--") || !a.startsWith("-")) return false;
    if (a.startsWith(flag)) return true; // -cfoo
    const letters = a.slice(1);
    for (const ch of letters) {
      if (ch === flag[1]) return true;
      if (takesValueLetters.includes(ch)) return false;
    }
    return false;
  });
}

function leadingFlagWords(args) {
  // the flags before the program or script name, with the one word that may follow a flag
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!(a.startsWith("-") || a.startsWith("+"))) {
      const prev = i === 0 ? undefined : args[i - 1];
      if (prev === undefined || !(prev.startsWith("-") || prev.startsWith("+"))) return out;
    }
    out.push(a);
  }
  return out;
}

const GIT_GLOBAL_FLAGS = ["-c", "-C"];
const GIT_GLOBAL_TREE = ["--git-dir", "--work-tree"];
const GIT_NEUTRAL_FLAGS = new Set(["-p", "-P", "--paginate", "--no-pager", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice", "--html-path", "--man-path", "--info-path", "--version", "--help"]);
const GIT_SUB_FLAGS = {
  rebase: ["-x"], difftool: ["--extcmd", "-x"], instaweb: ["-d"], config: ["--file", "-f", "edit", "--edit", "-e", "--rename-section", "rename-section"],
  "checkout-index": ["--prefix"], archive: ["-o"], "format-patch": ["-o", "--output-directory"], clone: ["--template", "-c", "--config", "-u"], init: ["--template"],
  grep: ["-O"], "filter-branch": ["--tree-filter", "--index-filter", "--msg-filter", "--env-filter", "--commit-filter", "--parent-filter", "--tag-name-filter", "--setup"],
  "send-email": ["--sendmail-cmd", "--smtp-server", "--to-cmd", "--cc-cmd"],
};
const GIT_RUN = [["bisect", "run"], ["submodule", "foreach"], ["hook", "run"]];
const GIT_CONFIG_KEYS = ["alias.", "core.fsmonitor", "core.sshcommand", "core.pager", "core.editor", "core.hookspath", "core.gitproxy", "sendemail.", "diff.", "difftool.", "merge.", "mergetool.", "filter.", "sequence.", "uploadpack.", "receivepack.", "credential.", "init.templatedir", "gpg.", "pager.", "browser.", "ssh.", "protocol.allow", "protocol.ext.", "protocol.fd.", "include.", "includeif.", "core.askpass", "core.alternaterefscommand", "trailer.", "imap.", "interactive.difffilter", "instaweb.", "man.", "guitool."];

/** The first word that is not a flag, and the words after it, for git's own subcommand reading. */
function gitSubcommands(args) {
  const out = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!a.startsWith("-")) { out.push(...args.slice(i, i + 3).filter((x) => !x.startsWith("-"))); break; }
    i += a.includes("=") || GIT_NEUTRAL_FLAGS.has(a) ? 1 : 2;
  }
  return out;
}

/**
 * Reasons a part cannot be covered whatever the entries say, from the program and its arguments. The part is the normalized
 * text (the wrappers and harmless assignments off). `first` says whether the part is the first of its call or the call has no
 * pipe: a program that reads its program from input is then not a risk.
 */
function programReasons(text, raw, first) {
  const words = wordsOf(text).map((w) => w.text);
  const word = words[0] || "";
  const name = programName(word);
  const args = words.slice(1);
  const out = [];

  // an argument with a variable, a substitution or a quote trick, for the programs whose flags are watched
  const watched = Object.prototype.hasOwnProperty.call(RISKY_FLAGS, name) || Object.prototype.hasOwnProperty.call(INTERPRETERS, name) || name === "git" || name === "docker";
  if (watched && /\$[{(A-Za-z_0-9@*#?$!-]/.test(raw.replace(/'[^']*'/g, ""))) {
    // a flag that takes its value from a variable cannot be checked: Claude Code keeps the call sandboxed
    if (args.some((a) => /^-/.test(a) && /\$/.test(a)) || /(?:^|[ \t])\$\{?[A-Za-z_0-9@*#?$!-]+\}?[ \t]*$/.test(raw.replace(/'[^']*'/g, "")) === false && args.some((a) => /^-.*\$/.test(a))) out.push("arg-expansion");
  }

  if (name === "git") {
    const sub = args;
    // flags before the subcommand
    const pre = [];
    for (let i = 0; i < sub.length; i++) { if (!sub[i].startsWith("-")) break; pre.push(sub[i]); if (!(sub[i].includes("=") || GIT_NEUTRAL_FLAGS.has(sub[i]))) i++; }
    if (pre.some((a) => GIT_GLOBAL_FLAGS.some((f) => a.startsWith(f))) || pre.some((a) => GIT_GLOBAL_TREE.some((f) => a === f || a.startsWith(`${f}=`))) || sub.some((a) => RISKY_FLAGS.git.some((f) => a === f || a.startsWith(`${f}=`)))) out.push("git-flag");
    const subs = gitSubcommands(sub).map((s) => s.normalize("NFKC").toLowerCase());
    for (const [a, b] of GIT_RUN) if (subs[0] === a && subs.slice(1).includes(b)) out.push("git-run");
    for (const [subName, flags] of Object.entries(GIT_SUB_FLAGS)) if (subs.includes(subName) && sub.some((a) => flags.some((f) => a === f || (f.startsWith("--") && a.startsWith(`${f}=`)) || (f.length === 2 && f.startsWith("-") && !f.startsWith("--") && a.startsWith(f) && /^-[A-Za-z]/.test(a) && subName === "clone")))) out.push("git-flag");
    if (subs[0] === "config" && sub.some((a, i) => i < sub.length - 1 && GIT_CONFIG_KEYS.some((k) => a.toLowerCase().startsWith(k)))) out.push("git-config");
    if (sub.some((a) => /(?:^|=)(?:ext|fd)::/i.test(a.replace(/^['"]/, "")))) out.push("git-path");
    // a clone, init, worktree add/move or bundle create with a path outside the project
    const forms = subs[0] === "worktree" ? `worktree ${subs[1] || ""}` : subs[0] === "bundle" ? `bundle ${subs[1] || ""}` : subs[0] || "";
    if (GIT_PATH_FORMS.includes(forms)) {
      const after = sub.slice(sub.findIndex((a) => !a.startsWith("-")) + (forms.includes(" ") ? 2 : 1));
      if (after.some((a) => /^[/\\~$]/.test(a) || /^[A-Za-z]:/.test(a) || a.split(/[/\\]/).includes(".."))) out.push("git-path");
    }
    return [...new Set(out)];
  }

  if (Object.prototype.hasOwnProperty.call(RISKY_FLAGS, name) && name !== "git") {
    // every argument is looked at, not only the flags before the subcommand: `docker ps -H tcp://x` stays sandboxed too
    const flags = RISKY_FLAGS[name];
    const kubectlValueLetters = ["n", "s", "o", "l", "c", "k", "L", "v", "e"];
    if (args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`) || (f.length === 2 && !f.startsWith("--") && hasFlag([a], f, name === "kubectl" ? kubectlValueLetters : [])) || (name === "aws" && f.startsWith("--") && a.startsWith("--") && a.split("=")[0].length > 2 && f.startsWith(a.split("=")[0]))))) out.push("risky-flag");
  }

  if (Object.prototype.hasOwnProperty.call(INTERPRETERS, name)) {
    const flags = INTERPRETERS[name];
    const lead = leadingFlagWords(args);
    const runsCode = lead.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`) || (f.length === 2 && !f.startsWith("--") && hasFlag([a], f, ["o", "O", "W", "X", "m", "d", "C", "I"]))));
    const rest = args.slice(lead.length);
    const fromInput = args.length === 0 || lead.some((a) => a === "-" || a === "-s") || (!first && rest.length === 0) || rest.some((a) => /^\/dev\/stdin$|^\/proc\/self\/fd\/0$|^\/dev\/fd\/0$/.test(a));
    if (runsCode || fromInput) out.push("interpreter");
  }

  if (!first && ["make", "at", "batch", "sqlite", "ed", "crontab"].includes(name)) out.push("pipe-stage");
  return out;
}

/**
 * Is the part something Claude Code can cover with an entry at all? Returns the reasons it cannot (an empty list: it can).
 *   part   { text }  the simple command with redirections taken out
 */
function coverableReasons(partText, normalized, first) {
  const out = [];
  const w = normalized.text;
  const word = wordsOf(w)[0] ? wordsOf(w)[0].text : "";
  const rawWord = wordsOf(partText)[0] ? wordsOf(partText)[0].text : "";
  if (w === "") { out.push("empty"); return out; }
  if (/^\d*(?:&?[<>]|>&)/.test(w.trimStart()) || /^\d*(?:&?[<>]|>&)/.test(partText.trimStart())) out.push("redirect");
  if (/[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/.test(partText.replace(/'[^']*'|"[^"]*"/g, ""))) out.push("unusual-space");
  if (["command", "builtin", "noglob"].includes(programName(word))) out.push("wrapper");
  else if (LOOKED_THROUGH.includes(programName(word)) && LOOKED_THROUGH.includes(word)) out.push("unlooked-wrapper");
  if (envKind(word) !== "none") out.push("env");
  if (/\$\{?IFS\b/.test(partText)) out.push("ifs");
  if (w.startsWith("-")) out.push("leading-dash");
  const never = neverCovered(word) || neverCovered(rawWord);
  if (never) out.push(never);
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\[|\+?=)/.test(w)) out.push("unsafe-assignment");
  if (/[$`\\'"*?[]/.test(word) || /[$`\\'"*?[]/.test(rawWord)) out.push("command-word");
  if (!out.length) out.push(...programReasons(w, partText, first));
  return [...new Set(out)];
}

/** Is the part only an assignment of a harmless variable, which Claude Code lets pass without an entry? */
function isHarmlessAssignment(part) {
  const t = part.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(?![-+/])([A-Za-z0-9_.:@,+=/-]*)$/.exec(t);
  return m !== null && SAFE_ENV.has(m[1]) && !["LC_ALL", "LC_CTYPE", "LANG", "LANGUAGE", "CHARSET"].includes(m[1].toUpperCase());
}

const VARIABLE_SET = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Parse the entries of excludedCommands once: [{ raw, parsed }]. */
export function parseEntries(list) {
  return list.map((raw) => ({ raw, parsed: parseContent(typeof raw === "string" ? raw : String(raw)) }));
}

/**
 * Analyze one call against the entries.
 *   command   the text Claude sends to the Bash tool
 *   entries   the strings of excludedCommands that Claude Code uses (from sandbox.mjs), or [{ raw, parsed, source }]
 * Returns { command, excluded, callReasons: [{ code, text }], parts: [{ text, covered, trivially, reasons, matched, normalized }], entries }.
 * `excluded` is true when Claude Code takes the call out of the sandbox.
 */
export function analyzeCall(command, entries) {
  const list = entries.map((e) => (typeof e === "string" ? { raw: e, parsed: parseContent(e) } : e.parsed ? e : { ...e, parsed: parseContent(e.raw) }));
  const out = { command, excluded: false, callReasons: [], parts: [], entries: list };
  const callIssue = (code) => { if (!out.callReasons.some((r) => r.code === code)) out.callReasons.push({ code, text: REASONS[code] }); };

  if (command.length > MAX_CALL_CHARS) { callIssue("too-long"); return out; }
  if (/[\x00-\x08\x0B-\x1F\x7F]/.test(command) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(command) || /(?:^|[^ \t\\])(?:\\\\)*\\\n|[ \t](?:\\\\)+\\\n/.test(command) || /~\[/.test(command) || /(?:^|[\s;&|])=[a-zA-Z_]/.test(command) || /<\d*-\d*>/.test(command)) callIssue("unusual-text");
  const parsed = parseBash(command);
  if (!parsed.ok) { callIssue("unparseable"); return finish(out); }
  for (const is of parsed.issues) if (COUNTED_ISSUES[is.kind]) callIssue(COUNTED_ISSUES[is.kind]);
  if (parsed.issues.some((i) => i.kind === "heredoc" || i.kind === "heredoc-tail" || i.kind === "compound-redirect")) callIssue("redirect");
  if (command.includes("`")) callIssue("substitution");
  if (/\$\(|<\(|>\(|\$\[|\$\{[ \t\n|]/.test(command.replace(/'[^']*'/g, ""))) callIssue(/<\(|>\(/.test(command) ? "process-substitution" : "substitution");
  if (/\$"/.test(command.replace(/'[^']*'/g, ""))) callIssue("quote-trick");

  const cmds = parsed.cmds;
  for (const c of cmds) {
    if (c.ctx.length) {
      const k = c.ctx.find((x) => x === "subshell") ? "subshell" : c.ctx.find((x) => x === "substitution") ? "substitution" : "control-flow";
      callIssue(k);
    }
    if (c.redirs.some((r) => !isDescriptorCopy(r))) callIssue("redirect");
    if (c.argv.length && c.argv[0].value === "[" ) callIssue("test-brackets");
    if (c.argv.length && c.argv[0].value === "[[") callIssue("test-brackets");
  }
  const top = cmds.filter((c) => c.ctx.length === 0);
  const hasPipe = /\|/.test(command.replace(/\|\|/g, "").replace(/'[^']*'|"[^"]*"/g, ""));
  top.forEach((c, index) => {
    const text = c.text;
    const part = { text, covered: false, trivially: false, reasons: [], matched: null, normalized: null };
    out.parts.push(part);
    if (isHarmlessAssignment(text)) { part.covered = true; part.trivially = true; return; }
    const first = index === 0 || !hasPipe;
    const normalized = normalizePart(text);
    part.normalized = normalized.text;
    const reasons = coverableReasons(text, normalized, first);
    if (reasons.length) { part.reasons = reasons.map((code) => ({ code, text: REASONS[code] })); return; }
    const cands = candidatesFor(text, normalized);
    for (const e of list) {
      const hit = cands.find((cand) => matches(e.parsed, cand));
      if (hit) { part.matched = { entry: e.raw, candidate: hit, source: e.source || null }; part.covered = true; return; }
    }
    part.reasons = [{ code: "no-entry", text: REASONS["no-entry"] }];
  });
  // a variable set in one part and read in another
  const setIn = new Map();
  top.forEach((c, i) => { const m = VARIABLE_SET.exec(c.text.trim()); if (m && c.argv.length === 0) setIn.set(m[1], i); });
  for (const [name, i] of setIn) if (top.some((c, j) => j !== i && new RegExp(`\\$[=^~]*\\{?${name}\\b`).test(c.text))) callIssue("variable-flow");
  return finish(out);

  function finish(o) {
    o.excluded = list.length > 0 && o.callReasons.length === 0 && o.parts.length > 0 && o.parts.every((p) => p.covered) && o.parts.some((p) => p.matched);
    return o;
  }
}

/**
 * Could an entry ever take a call out of the sandbox? An instance of the entry (each * becomes `x`) is analyzed against the
 * entry alone; when Claude Code would keep even that sandboxed, the entry never matches. Returns null, or { code, text, sample }.
 */
export function deadEntryReason(raw) {
  const entry = typeof raw === "string" ? raw : String(raw);
  if (entry.trim() === "") return { code: "empty", text: "an empty entry matches nothing", sample: "" };
  const e = parseContent(entry);
  if (e.type === "exact" && entry !== entry.trim()) return { code: "no-entry", text: "an exact entry with a space at its start or end never equals a call (Claude Code trims the call)", sample: entry };
  // an instance of the entry: every * becomes x (a \* stays a star)
  const filled = e.type === "exact" ? entry : e.type === "prefix" ? `${e.prefix} x` : entry.replace(/\\\*/g, "\u0001").replace(/\*+/g, "x").replace(/\u0001/g, "*").replace(/^ +/, "");
  // a wrapper entry such as `timeout *` is matched against calls like `timeout 5 docker ps`: also try it with a duration
  const samples = [filled];
  if (/^timeout /.test(filled) && !/^timeout (?:-\S+ )*\d/.test(filled)) samples.push(filled.replace(/^timeout /, "timeout 5 "));
  let worst = null;
  for (const sample of samples) {
    const r = analyzeCall(sample, [{ raw: entry, parsed: e }]);
    if (r.excluded) return null;
    if (worst) continue;
    if (r.callReasons.length) worst = { ...r.callReasons[0], sample };
    else {
      const p = r.parts.find((x) => !x.covered);
      if (p && p.reasons.length) worst = { ...p.reasons[0], sample };
    }
  }
  return worst;
}
