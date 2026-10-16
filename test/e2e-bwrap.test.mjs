// The bubblewrap command line the real Claude Code builds, and the merged-usr question of anthropics/claude-code#99680, on Linux
// with bubblewrap and socat. A stand-in for bwrap first on the PATH records its arguments and then runs the real one, so the test
// reads what Claude Code asked for. At zero tokens: the fake API on 127.0.0.1 answers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { claudeInfo, put, skip } from "./claude-sandbox.mjs";
import { runSession } from "./oracle.mjs";
import { trialGroups, realSys } from "../src/host.mjs";
import { run, world } from "./helpers.mjs";

const REAL = process.platform === "linux" ? realSys().which("bwrap") : null;
const SKIP = skip() || (process.platform !== "linux" && "bubblewrap exists on Linux only") || (!REAL && "bubblewrap is not installed on this machine");
const NUL = String.fromCharCode(0);

/** A bwrap that writes its arguments (NUL separated) to a file of its own in $CSD_ARGV, then runs the real one. */
function recorderAt(dir, name = "bwrap", real = REAL, tag = name) {
  put(path.join(dir, name), ["#!/bin/sh", `if [ -n "$CSD_ARGV" ]; then printf '%s\\0' "$@" > "$CSD_ARGV/${tag}-$$.argv"; fi`, `exec "${real}" "$@"`, ""].join("\n"), 0o755);
}
const argvDir = (sb) => { const d = path.join(sb.root, "argv"); fs.mkdirSync(d, { recursive: true }); return d; };
const setupRecorder = (sb) => { argvDir(sb); recorderAt(sb.bin); };

/** The command lines that were recorded: [[arg, ...], ...]. */
const recorded = (sb, prefix = "bwrap-") => fs.readdirSync(argvDir(sb)).filter((n) => n.startsWith(prefix)).map((n) => fs.readFileSync(path.join(argvDir(sb), n), "utf8").split(NUL).slice(0, -1));

/** The index of the first place at or after `from` where `group` stands as a run of arguments, or -1. */
function find(argv, group, from = 0) {
  for (let i = from; i + group.length <= argv.length; i++) if (group.every((g, k) => argv[i + k] === g)) return i;
  return -1;
}

/** The command line of the call that ran a command: the one with --unshare-net. */
const callLine = (sb) => recorded(sb).find((a) => a.includes("--unshare-net"));

/** Every group of the trial stands in the line, in the order of the trial. Returns the place of each. */
function inOrder(argv, groups) {
  let at = -1;
  return groups.map((g) => {
    const i = find(argv, g, at + 1);
    assert.ok(i > at, `${g.join(" ")} stands after position ${at} of the command line`);
    at = i;
    return i;
  });
}

test("the command line Claude Code gives bubblewrap holds the flags of the trial that `check` makes, in the same order, and the project folder is the writable one", { skip: SKIP, timeout: 300000 }, async (t) => {
  const r = await runSession({ label: "bwrap-argv", user: { sandbox: { enabled: true } }, project: {}, commands: ["echo hi"], programs: [], setup: setupRecorder, env: (sb) => ({ CSD_ARGV: argvDir(sb) }) });
  assert.match(r.calls[0].text, /hi/);
  const argv = callLine(r.sb);
  assert.ok(argv, `bubblewrap was started with --unshare-net; it was started ${recorded(r.sb).length} times`);
  inOrder(argv, trialGroups(false));
  const work = fs.realpathSync(r.sb.work);
  for (const g of [["--setenv", "SANDBOX_RUNTIME", "1"], ["--bind", work, work], ["--ro-bind", "/dev/null", path.join(work, ".claude", "settings.json")], ["--", "/bin/bash", "-c"]]) assert.ok(find(argv, g) >= 0, `${g.join(" ")} is in the command line`);
  assert.equal(find(argv, ["--ro-bind", work, work]), -1, "the project folder is not read-only");
  t.diagnostic(`Claude Code ${claudeInfo().version}: ${argv.length} arguments; the trial's flags in order: ${trialGroups(false).map((g) => g.join(" ")).join(" | ")}; the call ended with ${argv.slice(find(argv, ["--", "/bin/bash"])).slice(0, 4).join(" ")}`);
});

test("with enableWeakerNestedSandbox the /proc is the host's, bound in place of a fresh one, and the rest of the line is the same", { skip: SKIP, timeout: 300000 }, async (t) => {
  const r = await runSession({ label: "bwrap-weaker", user: { sandbox: { enabled: true, enableWeakerNestedSandbox: true } }, project: {}, commands: ["echo hi"], programs: [], setup: setupRecorder, env: (sb) => ({ CSD_ARGV: argvDir(sb) }) });
  const argv = callLine(r.sb);
  assert.ok(argv, `bubblewrap was started with --unshare-net; calls: ${JSON.stringify(r.calls.map((c) => c && c.text))}`);
  inOrder(argv, trialGroups(true));
  assert.equal(find(argv, ["--proc", "/proc"]), -1, "no fresh /proc");
  t.diagnostic(`Claude Code ${claudeInfo().version}: with enableWeakerNestedSandbox the line has ${find(argv, ["--bind", "/proc", "/proc"]) >= 0 ? "--bind /proc /proc" : "no --bind /proc /proc"}`);
});

test("sandbox.bwrapPath and sandbox.socatPath in a user file are not used: the bwrap and the socat on the PATH are", { skip: SKIP, timeout: 300000 }, async () => {
  let alt;
  const r = await runSession({
    label: "bwrap-path",
    project: {},
    commands: ["echo hi"],
    programs: [],
    setup: (sb) => {
      setupRecorder(sb);
      alt = path.join(sb.root, "alt");
      recorderAt(alt, "bwrap", REAL, "alt-bwrap");
      recorderAt(alt, "socat", realSys().which("socat"), "alt-socat");
      put(sb.user, { sandbox: { enabled: true, bwrapPath: path.join(alt, "bwrap"), socatPath: path.join(alt, "socat") } });
    },
    user: undefined,
    env: (sb) => ({ CSD_ARGV: argvDir(sb) }),
  });
  assert.match(r.calls[0].text, /hi/);
  assert.ok(callLine(r.sb), "the bwrap on the PATH ran the call");
  // the stand-ins at the paths in the user file never ran: each would have left a file named after itself
  assert.deepEqual(fs.readdirSync(argvDir(r.sb)).filter((n) => n.startsWith("alt-")), [], "neither the bwrap of bwrapPath nor the socat of socatPath ran");
});

test("merged-usr (anthropics/claude-code#99680): /bin/bash runs inside the mounts Claude Code asks for, a mount of /usr alone fails with the message of the issue, and `check` says which", { skip: SKIP, timeout: 300000 }, async (t) => {
  const merged = fs.lstatSync("/bin").isSymbolicLink();
  const bwrap = (...args) => spawnSync(REAL, args, { encoding: "utf8", timeout: 30000 });
  const whole = bwrap("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/bash", "-c", "echo whole-ok");
  const usrOnly = bwrap("--ro-bind", "/usr", "/usr", "--dev", "/dev", "--proc", "/proc", "--", "/bin/bash", "-c", "echo usr-ok");
  const links = fs.existsSync("/lib64") ? ["--symlink", "usr/lib64", "/lib64"] : [];
  const withLinks = bwrap("--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", ...links, "--dev", "/dev", "--proc", "/proc", "--", "/bin/bash", "-c", "echo links-ok");
  t.diagnostic(`/bin is ${merged ? "a link (merged-usr)" : "a folder"}; --ro-bind / /: ${whole.status === 0 ? "ran" : `failed: ${whole.stderr.trim()}`}; --ro-bind /usr /usr: ${usrOnly.status === 0 ? "ran" : `failed: ${usrOnly.stderr.trim()}`}; /usr with the links: ${withLinks.status === 0 ? "ran" : `failed: ${withLinks.stderr.trim()}`}`);
  assert.equal(whole.status, 0, whole.stderr);
  assert.match(whole.stdout, /whole-ok/);
  assert.notEqual(usrOnly.status, 0, "/usr alone leaves no /bin/bash");
  assert.match(usrOnly.stderr, /bwrap: execvp \/bin\/bash: No such file or directory/);
  assert.equal(withLinks.status, 0, withLinks.stderr);
  // what Claude Code does on this machine, and what `check` says about the same
  const w = world("merged");
  const c = (await run(["check", "--json"], w)).json();
  const item = c.items.find((i) => i.id === "merged-usr");
  assert.ok(item, "check has a merged-usr item");
  assert.equal(item.status, "ok");
  assert.equal(/merged-usr/.test(item.title), merged);
  const live = await runSession({ label: "merged", user: { sandbox: { enabled: true } }, commands: ["/bin/bash -c 'echo inside=$SANDBOX_RUNTIME'"], programs: [] });
  assert.match(live.calls[0].text, /inside=1/, "Claude Code ran /bin/bash inside the sandbox on this machine");
});
