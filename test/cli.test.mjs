// The command line: every usage error, the exit codes, --json for each command, --markdown for the skill, the help text, the version,
// and the commands through the real entry point in a child process.
import test from "node:test";
import assert from "node:assert/strict";
import { CLI, run, runCli, world } from "./helpers.mjs";
import { parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";
import { MAC, WINDOWS, ubuntu } from "./fakesys.mjs";

test("parseArgs: commands, options with values, --opt=value, positional arguments", () => {
  assert.deepEqual({ ...parseArgs(["why", "docker ps", "--project", "x", "--retry", "--json"]) }, { command: "why", positional: ["docker ps"], project: "x", claude: null, live: false, retry: true, json: true, markdown: false, help: false, version: false, noColor: false });
  assert.equal(parseArgs(["check", "--live", "--claude=/x/claude"]).claude, "/x/claude");
  assert.equal(parseArgs(["lint", "--markdown"]).markdown, true);
  assert.throws(() => parseArgs(["lint", "--json", "--markdown"]), /cannot be combined/);
  assert.throws(() => parseArgs(["lint", "--nope"]), /unknown option --nope/);
  assert.throws(() => parseArgs(["show", "--project"]), /--project needs a folder/);
  assert.throws(() => parseArgs(["show", "--project", "--json"]), /--project needs a folder/);
  assert.throws(() => parseArgs(["check", "--claude"]), /--claude needs a value/);
  assert.throws(() => parseArgs(["check", "--live=1"]), /does not take a value/);
});

test("usage errors exit 2 with a message and a pointer to --help; with --json they are a document", async () => {
  const w = world("cli-usage");
  for (const [args, text] of [[[], /a command is needed/], [["frobnicate"], /unknown command frobnicate/], [["show", "extra"], /show takes no arguments/], [["lint", "x"], /lint takes no arguments/], [["check", "x"], /check takes no arguments/], [["show", "--markdown"], /--markdown does not belong to show/], [["show", "--live"], /--live does not belong to show/], [["why", "x", "--live"], /--live does not belong to why/], [["lint", "--retry"], /--retry does not belong to lint/], [["check", "--claude", "x"], /add --live/], [["check", "--live", "--markdown"], /cannot be combined/], [["why"], /why takes one argument/]]) {
    const r = await run(args, w);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, text, JSON.stringify(args));
    assert.match(r.err, /Try: claude-sandbox-doctor --help/);
    assert.equal(r.out, "");
  }
  const j = await run(["why", "--json"], w);
  assert.equal(j.code, 2);
  assert.deepEqual(JSON.parse(j.out), { ok: false, error: 'why takes one argument: the command, in quotes, as in why "docker compose up"' });
});

test("--help and --version print and exit 0, whatever else is on the line", async () => {
  const w = world("cli-help");
  const h = await run(["--help"], w);
  assert.equal(h.code, 0);
  assert.match(h.out, new RegExp(`^claude-sandbox-doctor ${VERSION.replace(/\./g, "\\.")}\\n`));
  for (const cmd of ["check", "show", "why", "lint"]) assert.match(h.out, new RegExp(`^  ${cmd} `, "m"), cmd);
  for (const flag of ["--live", "--claude <path>", "--retry", "--project <dir>", "--markdown", "--json", "--no-color", "-h, --help", "-v, --version"]) assert.ok(h.out.includes(flag), flag);
  assert.equal((await run(["lint", "--help"], w)).out, h.out);
  const v = await run(["--version"], w);
  assert.equal(v.out, `${VERSION}\n`);
  assert.equal((await run(["-v"], w)).out, `${VERSION}\n`);
});

test("show: the merged settings through the command line, as text and as JSON", async () => {
  const w = world("cli-show");
  w.user({ sandbox: { enabled: true, excludedCommands: ["docker *"], network: { allowedDomains: ["github.com"] } } });
  w.project({ sandbox: { excludedCommands: ["make *"], autoAllowBashIfSandboxed: false } });
  const t = await run(["show"], w, { sys: ubuntu({ profile: true }) });
  assert.equal(t.code, 0);
  assert.match(t.out, /^claude-sandbox-doctor 1\.0\.0 {2}the sandbox settings Claude Code merges\n/);
  assert.match(t.out, /^system {4}Linux, Ubuntu 24\.04\.5 LTS\n/m);
  assert.match(t.out, /^ {2}project +\.claude\/settings\.json +read, 2 sandbox keys$/m);
  assert.match(t.out, /^ {2}enabled +true +user ~\/\.claude\/settings\.json:3$/m);
  assert.match(t.out, /autoAllowBashIfSandboxed +false +project \.claude\/settings\.json:6/);
  assert.match(t.out, /excludedCommands +2 entries/);
  assert.match(t.out, /"docker \*" +user ~\/\.claude\/settings\.json:5/);
  assert.match(t.out, /Not read by this tool:/);
  const j = (await run(["show", "--json"], w, { sys: ubuntu({ profile: true }) })).json();
  assert.equal(j.ok, true);
  assert.equal(j.effective.enabled, true);
  assert.equal(j.effective.autoAllowBashIfSandboxed, false);
  assert.deepEqual(j.values.enabled.winner.source.scope, "user");
  assert.deepEqual(j.lists.excludedCommands.map((i) => i.value).sort(), ["docker *", "make *"]);
  assert.equal(j.platform.id, "linux");
  assert.equal(JSON.stringify(j).includes("\"parsed\""), false, "nothing internal leaks into the document");
});

test("show names what is left out: a file Claude Code ignores, an entry an admin-required sandbox ignores", async () => {
  const w = world("cli-show-out");
  w.managed({ sandbox: { enabled: true, allowUnsandboxedCommands: false } });
  w.project({ sandbox: { excludedCommands: ["docker *"] } });
  w.write(w.localFile, '{ // c\n "sandbox": { "enabled": true } }');
  const t = (await run(["show"], w, { sys: ubuntu({ profile: true }) })).out;
  assert.match(t, /ignored by Claude Code: a comment/);
  assert.match(t, /admin-required +yes \(managed settings set allowUnsandboxedCommands to false\)/);
  assert.match(t, /ignored \(the sandbox is admin-required/);
});

test("check through the command line: Windows says there is no sandbox and exits 0; a Linux that cannot start it exits 1; --markdown always exits 0", async () => {
  const w = world("cli-check");
  const win = await run(["check"], w, { sys: WINDOWS() });
  assert.equal(win.code, 0);
  assert.match(win.out, /No Bash sandbox on Windows/);
  assert.match((await run(["check", "--json"], w, { sys: WINDOWS() })).json().summary, /no Bash sandbox/);
  const bad = await run(["check"], w, { sys: ubuntu({ profile: false }) });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAIL +bubblewrap cannot start a sandbox: bwrap: loopback: Failed RTM_NEWADDR: Operation not\s+permitted/);
  assert.match(bad.out, /fix: Add an AppArmor profile/);
  const md = await run(["check", "--markdown"], w, { sys: ubuntu({ profile: false }) });
  assert.equal(md.code, 0);
  assert.match(md.out, /^## sandbox-doctor check: Linux, Ubuntu 24\.04\.5 LTS\n- OK bubblewrap 0\.9\.0/);
  assert.match(md.out, /- FAIL bubblewrap cannot start a sandbox/);
  assert.ok(md.out.trim().split("\n").length <= 9);
  const good = await run(["check"], w, { sys: ubuntu({ profile: true }) });
  assert.equal(good.code, 0);
  assert.match(good.out, /The sandbox can start on this machine\./);
  assert.equal((await run(["check"], w, { sys: MAC() })).code, 0);
});

test("check reads bwrapPath and socatPath from managed settings, and enableWeakerNestedSandbox from the merge", async () => {
  const w = world("cli-check-managed");
  w.managed({ sandbox: { enabled: true, bwrapPath: "/opt/admin/bwrap" } });
  const j = (await run(["check", "--json"], w, { sys: ubuntu({ profile: true }) })).json();
  assert.equal(j.items.find((i) => i.id === "bwrap").status, "fail");
  assert.match(j.items.find((i) => i.id === "bwrap").title, /bubblewrap is not at \/opt\/admin\/bwrap \(sandbox\.bwrapPath\)/);
});

test("check --live: skipped where there is no sandbox or no claude; run through runLive where there is", async () => {
  const w = world("cli-live");
  const win = (await run(["check", "--live", "--json"], w, { sys: WINDOWS() })).json();
  assert.equal(win.live.skipped, true);
  assert.match(win.live.reason, /no Bash sandbox on Windows/);
  const noClaude = await run(["check", "--live", "--json"], w, { sys: ubuntu({ profile: true }) });
  assert.equal(noClaude.json().live.skipped, true);
  assert.match(noClaude.json().live.reason, /claude was not found on PATH/);
  const sys = ubuntu({ profile: true });
  sys.which = (n) => (n === "claude" ? "/usr/local/bin/claude" : { bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat", unshare: "/usr/bin/unshare" }[n] || null);
  const ok = { version: "2.1.301 (Claude Code)", ok: true, warnings: [], probes: [{ id: "inside", title: "a command runs inside the sandbox", outcome: "inside", evidence: "SANDBOX_RUNTIME=1: the command ran inside the sandbox" }, { id: "write", title: "a write outside the project", outcome: "blocked", evidence: "the write failed: Read-only file system" }, { id: "network", title: "a connection to a host that is not allowed", outcome: "blocked", evidence: "the sandbox's proxy refused it" }] };
  const live = await run(["check", "--live"], w, { sys, runLive: async () => ok });
  assert.equal(live.code, 0);
  assert.match(live.out, /Claude Code, put to the test \(--live\)/);
  assert.match(live.out, /blocked {3}a write outside the project/);
  assert.match(live.out, /The sandbox kept the command inside, refused the write and refused the connection\./);
  const notBlocked = await run(["check", "--live"], w, { sys, runLive: async () => ({ ...ok, ok: false, probes: ok.probes.map((p) => (p.id === "write" ? { ...p, outcome: "outside", evidence: "the file outside the project was created" } : p)) }) });
  assert.equal(notBlocked.code, 1);
  assert.match(notBlocked.out, /outside {3}a write outside the project/);
  assert.match(notBlocked.out, /did not all end as a working sandbox would end them/);
});

test("lint through the command line: the exit code follows the findings; --json has the counts and the files", async () => {
  const w = world("cli-lint");
  w.user({ sandbox: { enabled: true, excludedCommands: ["docker"] } });
  const r = await run(["lint", "--json"], w, { sys: ubuntu({ profile: true }) });
  assert.equal(r.code, 1);
  const j = r.json();
  assert.deepEqual(j.counts, { error: 0, warning: 1, note: 0 });
  assert.equal(j.files.filter((f) => f.exists).length, 1);
  assert.equal(j.platform.id, "linux");
  assert.equal((await run(["lint"], world("cli-lint-clean"), { sys: ubuntu({ profile: true }) })).code, 0);
});

test("the entry point runs in a child process, with a throwaway home, and exits with the code of the command", () => {
  const w = world("cli-child");
  w.user({ sandbox: { enabled: true, excludedCommands: ["docker"] } });
  const lint = runCli(["lint"], { cwd: w.work, env: w.env });
  assert.equal(lint.code, 1, lint.all);
  assert.match(lint.out, /bare-entry/);
  const why = runCli(["why", "docker ps > x"], { cwd: w.work, env: w.env });
  assert.equal(why.code, 0, why.all);
  assert.match(why.out, /inside the sandbox/);
  const usage = runCli(["nope"], { cwd: w.work, env: w.env });
  assert.equal(usage.code, 2);
  assert.match(usage.err, /unknown command nope/);
  const ver = runCli(["--version"], { cwd: w.work, env: w.env });
  assert.equal(ver.out.trim(), VERSION);
  assert.ok(CLI.endsWith("claude-sandbox-doctor.mjs"));
  // a settings folder with spaces and a project given with --project, from another folder
  const other = runCli(["lint", "--project", w.work, "--json"], { cwd: w.base, env: w.env });
  assert.equal(JSON.parse(other.out).project, w.work);
});

test("runCli refuses an environment that is not a throwaway one", () => {
  assert.throws(() => runCli(["lint"], { env: { CLAUDE_CONFIG_DIR: "/definitely/not/temp", HOME: "/definitely/not/temp", USERPROFILE: "/definitely/not/temp" } }), /throwaway|temporary/);
});
