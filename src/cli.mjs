// The command line: parse the arguments, run one command, print, return the exit code.
// Exit codes: 0 ok; 1 findings, or a refusal (the sandbox cannot start, a probe was not blocked, a retry that Claude Code would
// ignore, a call that a deny rule refuses); 2 a usage error, or something that went wrong that the tool did not expect.
import os from "node:os";
import path from "node:path";
import { buildCheckModel, buildLintModel, buildShowModel, buildWhyModel } from "./commands.mjs";
import { markdownCheck, markdownLint, palette, renderCheck, renderLint, renderShow, renderWhy, strip } from "./render.mjs";
import { VERSION } from "./version.mjs";

const HELP = `claude-sandbox-doctor ${VERSION}
Whether Claude Code's Bash sandbox works on this machine, and why a command ran inside it, outside it, or not at all.

Usage: claude-sandbox-doctor <command> [options]

Read (they change nothing):
  check    [--live] [--claude <path>] [--markdown]
           whether the Bash sandbox can start on this machine, without running Claude Code: the system;
           on Linux and WSL2 bubblewrap and socat, user namespaces (and the AppArmor limit on them), the
           merged-usr layout (/bin/bash inside the mounts), a nested user namespace, a container; on
           macOS sandbox-exec. On Windows and WSL1 it says there is no Bash sandbox and exits 0.
           --live also runs the real Claude Code (the one on PATH, or --claude) in a throwaway config
           against a fake API on 127.0.0.1, at zero tokens, with the sandbox on, and asks for a command
           inside the sandbox, a write outside the project and a connection to a host that is not
           allowed; it says whether each was blocked, ran outside, or was refused. Exit 1 when the
           sandbox cannot start, or a probe was not blocked. --markdown is the short form the
           /sandbox-doctor:check skill hands to Claude; it always exits 0
  show     [--project <dir>]
           the merged sandbox settings (managed, local, project, user): every value with the file and
           line it came from, which file wins, what it shadows, the entries Claude Code leaves out (a key
           that only user or managed settings may set; what an admin-required sandbox ignores in a
           repository's files), and the permission settings that reach the sandbox
  why      "<command>" [--retry] [--project <dir>]
           whether Claude Code runs the Bash call inside the sandbox, outside it (which excludedCommands
           entry matched each part, or why no entry did: the whole call has a redirection, a command
           substitution or a cd; a part is sudo, eval, xargs, a shell given -c, git given -C, a variable
           in front, a wrapper it does not read ...), and whether autoAllowBashIfSandboxed approves it
           without a prompt. --retry asks the other question: the model sets dangerouslyDisableSandbox
           after a failure; Claude Code honors it, or refuses it (allowUnsandboxedCommands is false).
           Exit 1 when the answer is "refused" or a deny rule refuses the call
  lint     [--project <dir>] [--markdown]
           sandbox settings that can never take effect: excludedCommands entries that never match, an
           allowedDomains entry with a scheme, a path or a bad port, failIfUnavailable on a machine that
           cannot start the sandbox, settings inert on this system, keys the wrong file sets,
           bwrapPath and socatPath outside managed settings, autoAllowBashIfSandboxed with the sandbox
           off, allowWrite entries for protected paths, enableWeakerNestedSandbox. Exit 1 on an error or
           a warning. --markdown is the short form for the skill; it always exits 0

Files: --project <dir> is the folder Claude Code starts in (the current folder when you leave it out);
its settings are <dir>/.claude/settings.json and settings.local.json. The user settings are in the
config folder (CLAUDE_CONFIG_DIR, else ~/.claude), and managed settings in /etc/claude-code on Linux and
WSL2, /Library/Application Support/ClaudeCode on macOS, C:\\Program Files\\ClaudeCode on Windows.

Options for every command:
  --json         one JSON document on stdout
  --no-color     no colour on a terminal (NO_COLOR does the same)
  -h, --help     this text
  -v, --version  the version

Exit codes: 0 ok; 1 findings, a refusal, or a sandbox that cannot work; 2 a usage error or an unexpected error.
Environment: CLAUDE_CONFIG_DIR (Claude's config folder), NO_COLOR, and
CLAUDE_SANDBOX_DOCTOR_MANAGED_DIR (the folder to read managed-settings.json from, instead of the
system folder; the tests use it).
It reads settings files and writes nothing. It starts programs only in check (bubblewrap, socat, unshare
and sandbox-exec, with a few harmless trial arguments) and, with --live, Claude Code itself; the only
connection it opens is --live's listener on 127.0.0.1, and it sends nothing anywhere.
`;

class UsageError extends Error {}

const COMMANDS = new Set(["check", "show", "why", "lint"]);
const FLAGS_WITH_VALUE = new Set(["--project", "--claude"]);
const FLAGS = new Set([...FLAGS_WITH_VALUE, "--live", "--retry", "--json", "--markdown", "--no-color", "-h", "--help", "-v", "--version"]);

/** Parse argv into { command, positional, project, claude, live, retry, json, markdown, noColor, help, version }. */
export function parseArgs(argv) {
  const o = { command: null, positional: [], project: null, claude: null, live: false, retry: false, json: false, markdown: false, help: false, version: false, noColor: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith("--") && a.includes("=")) { inline = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    if (a.startsWith("-") && a !== "-") {
      if (!FLAGS.has(a)) throw new UsageError(`unknown option ${a}`);
      let value = null;
      if (FLAGS_WITH_VALUE.has(a)) {
        value = inline !== null ? inline : argv[++i];
        if (value === undefined || (inline === null && value.startsWith("-") && value.length > 1)) {
          throw new UsageError(a === "--project" ? "--project needs a folder (use --project . for the current folder)" : `${a} needs a value`);
        }
      } else if (inline !== null) throw new UsageError(`${a} does not take a value`);
      switch (a) {
        case "--project": o.project = value; break;
        case "--claude": o.claude = value; break;
        case "--live": o.live = true; break;
        case "--retry": o.retry = true; break;
        case "--json": o.json = true; break;
        case "--markdown": o.markdown = true; break;
        case "--no-color": o.noColor = true; break;
        case "-h": case "--help": o.help = true; break;
        case "-v": case "--version": o.version = true; break;
        default:
      }
      continue;
    }
    if (o.command === null && COMMANDS.has(a)) o.command = a;
    else o.positional.push(a);
  }
  if (o.json && o.markdown) throw new UsageError("--json and --markdown cannot be combined");
  return o;
}

/**
 * Run the tool. `io` lets tests capture output and fake the machine:
 * { stdout, stderr, env, cwd, home, platform, managed, now, sys, runLive }.
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const home = io.home || os.homedir();
  const cwd = io.cwd || process.cwd();
  const platform = io.platform || process.platform;
  const wantsJson = argv.includes("--json");

  const fail = (message, code) => {
    if (wantsJson) stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else stderr.write(`claude-sandbox-doctor: ${message}${code === 2 ? "\nTry: claude-sandbox-doctor --help" : ""}\n`);
    return code;
  };

  let o;
  try {
    o = parseArgs(argv);
    if (!o.help && !o.version && o.command === null) throw new UsageError(o.positional.length ? `unknown command ${o.positional[0]}` : "a command is needed");
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    return fail(e.message, 2);
  }
  if (o.help) { stdout.write(HELP); return 0; }
  if (o.version) { stdout.write(`${VERSION}\n`); return 0; }

  const color = !!stdout.isTTY && !env.NO_COLOR && !o.noColor;
  const common = { env, home, platform, managed: io.managed, cwd, sys: io.sys };
  const emit = (model, text) => stdout.write(o.json ? `${JSON.stringify(strip(model), null, 2)}\n` : text);

  try {
    const allowed = { check: ["--live", "--claude", "--markdown"], show: [], why: ["--retry"], lint: ["--markdown"] }[o.command];
    for (const [flag, on] of [["--live", o.live], ["--claude", o.claude !== null], ["--retry", o.retry], ["--markdown", o.markdown]]) {
      if (on && !allowed.includes(flag)) throw new UsageError(`${flag} does not belong to ${o.command}`);
    }
    if (o.claude !== null && !o.live) throw new UsageError("--claude names the Claude Code that --live runs; add --live");
    const projectDir = o.project !== null ? path.resolve(cwd, o.project) : path.resolve(cwd);

    switch (o.command) {
      case "check": {
        if (o.positional.length) throw new UsageError(`check takes no arguments (got "${o.positional[0]}")`);
        if (o.live && o.markdown) throw new UsageError("--live and --markdown cannot be combined: the skill never runs the real binary");
        const m = await buildCheckModel({ ...common, project: projectDir, live: o.live, claude: o.claude, runLive: io.runLive });
        if (o.markdown) { stdout.write(markdownCheck(m)); return 0; } // a skill whose command exits 1 never reaches the model
        emit(m, renderCheck(m, { color }));
        return m.ok ? 0 : 1;
      }
      case "show": {
        if (o.positional.length) throw new UsageError(`show takes no arguments (got "${o.positional[0]}")`);
        const m = buildShowModel({ ...common, project: projectDir });
        emit(m, renderShow(m, { color }));
        return 0;
      }
      case "why": {
        if (o.positional.length !== 1) throw new UsageError('why takes one argument: the command, in quotes, as in why "docker compose up"');
        if (o.positional[0].trim() === "") throw new UsageError("the command is empty");
        const m = buildWhyModel({ ...common, project: projectDir, command: o.positional[0], retry: o.retry });
        emit(m, renderWhy(m, { color }));
        return m.verdict === "refused" || m.approval.how === "denied" ? 1 : 0;
      }
      case "lint": {
        if (o.positional.length) throw new UsageError(`lint takes no arguments (got "${o.positional[0]}")`);
        const m = buildLintModel({ ...common, project: projectDir });
        if (o.markdown) { stdout.write(markdownLint(m)); return 0; }
        emit(m, renderLint(m, { color }));
        return m.counts.error + m.counts.warning > 0 ? 1 : 0;
      }
      default:
        throw new UsageError(`unknown command ${o.command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) return fail(e.message, 2);
    return fail(`something went wrong that was not expected: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`, 2);
  }
}

export { palette };
