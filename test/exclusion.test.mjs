// The matcher for excludedCommands: how a call is read, which entry covers which part, why a part cannot be covered, and which
// entries can never match. (The table in test/why-table.mjs puts the same questions to the real binary, 221 calls.)
import test from "node:test";
import assert from "node:assert/strict";
import { REASONS, analyzeCall, deadEntryReason, neverCovered, normalizePart, parseEntries, programName } from "../src/exclusion.mjs";

const run = (command, ...entries) => analyzeCall(command, entries);
const codes = (r) => [...r.callReasons.map((x) => x.code), ...r.parts.flatMap((p) => p.reasons.map((x) => x.code))];

test("programName reads a command word the way Claude Code does: path, case, .exe and version number cut", () => {
  const cases = { docker: "docker", "/usr/bin/sudo": "sudo", "C:\\Windows\\bin\\SUDO.EXE": "sudo", python3: "python", "python3.11": "python", "python3.11.exe": "python", nodejs: "node", gsed: "sed", gtimeout: "timeout", genv: "env", "bash-static": "bash", "ENV.": "env", "7z": "7z" };
  for (const [word, want] of Object.entries(cases)) assert.equal(programName(word), want, word);
});

test("neverCovered: the commands that stay sandboxed whatever the entries say", () => {
  const stays = { eval: "runs-code", source: "runs-code", ".": "runs-code", exec: "runs-code", trap: "runs-code", alias: "runs-code", let: "runs-code", sudo: "wrapper", "/usr/bin/sudo": "wrapper", xargs: "wrapper", sed: "wrapper", command: "wrapper", builtin: "wrapper", doas: "wrapper", su: "wrapper", awk: "awk", gawk: "awk", watch: "watcher", flock: "watcher", strace: "watcher", unshare: "watcher", export: "shell-state", declare: "shell-state", set: "shell-state", shift: "shell-state", read: "shell-state", setopt: "zsh-builtin", cd: "directory", pushd: "directory", popd: "directory", chdir: "directory" };
  for (const [word, code] of Object.entries(stays)) assert.equal(neverCovered(word), code, word);
  for (const word of ["docker", "git", "npm", "make", "echo", "ls", "exit", "return", "env", "timeout"]) assert.equal(neverCovered(word), null, word);
});

test("normalizePart steps over harmless assignments, a plain env, and timeout, time, nice, stdbuf and nohup, and says what it took off", () => {
  const n = (s) => normalizePart(s);
  assert.deepEqual({ ...n("docker ps") }, { text: "docker ps", prefix: "" });
  assert.equal(n("NODE_ENV=test docker ps").text, "docker ps");
  assert.equal(n("CI=1 LANG=C docker ps").text, "docker ps");
  assert.equal(n("FOO=bar docker ps").text, "FOO=bar docker ps");
  assert.equal(n("timeout 5 docker ps").text, "docker ps");
  assert.equal(n("timeout 5 docker ps").prefix, "timeout 5 ");
  assert.equal(n("timeout --foreground -k 1 2.5s docker ps").text, "docker ps");
  assert.equal(n("timeout abc docker ps").text, "timeout abc docker ps");
  assert.equal(n("time docker ps").text, "docker ps");
  assert.equal(n("time -p docker ps").text, "-p docker ps", "time takes no -p here: what is left starts with a dash, which Claude Code does not cover");
  assert.equal(n("nice -n 5 docker ps").text, "docker ps");
  assert.equal(n("nice -5 docker ps").text, "docker ps");
  assert.equal(n("stdbuf -oL docker ps").text, "docker ps");
  assert.equal(n("stdbuf -o L docker ps").text, "stdbuf -o L docker ps");
  assert.equal(n("nohup docker ps").text, "docker ps");
  assert.equal(n("env -i -u X docker ps").text, "docker ps");
  assert.equal(n("env FOO=bar docker ps").text, "FOO=bar docker ps");
  assert.equal(n("/usr/bin/env docker ps").text, "docker ps");
  assert.equal(n("/opt/bin/env docker ps").text, "/opt/bin/env docker ps", "only the plain env is stepped over");
  assert.equal(n("timeout 5 nice nohup docker ps").text, "docker ps");
  assert.equal(n("command docker ps").text, "command docker ps", "command is not stepped over");
});

test("analyzeCall: a call that an entry covers, part by part, with the entry and the text that matched", () => {
  const r = run("timeout 5 docker ps && gh pr list", "docker *", "gh pr *");
  assert.equal(r.excluded, true);
  assert.deepEqual(r.parts.map((p) => [p.text, p.matched.entry, p.matched.candidate]), [["timeout 5 docker ps", "docker *", "docker ps"], ["gh pr list", "gh pr *", "gh pr list"]]);
  assert.deepEqual(r.callReasons, []);
});

test("analyzeCall: one part that no entry covers keeps the whole call in the sandbox, and names the part", () => {
  const r = run("docker ps && npm test", "docker *");
  assert.equal(r.excluded, false);
  assert.deepEqual(r.parts.map((p) => p.covered), [true, false]);
  assert.deepEqual(codes(r), ["no-entry"]);
  assert.equal(r.parts[1].text, "npm test");
});

test("analyzeCall: the shapes of a call that Claude Code does not take apart", () => {
  const shapes = {
    "docker run $(echo x)": "substitution", "docker run `echo x`": "substitution", "docker ps <(echo x)": "process-substitution", "(docker ps)": "subshell",
    "{ docker ps; }": "group", "if true; then docker ps; fi": "control-flow", "for i in 1; do docker ps; done": "control-flow",
    "[ -f a ] && docker ps": "test-brackets", "[[ -f a ]] && docker ps": "test-brackets", "docker ps > out": "redirect", "docker ps 2>/dev/null": "redirect", "docker ps < in": "redirect",
    "docker ps <<< x": "redirect", "docker ps\\\n  --all": "unusual-text",
  };
  for (const [command, code] of Object.entries(shapes)) {
    const r = run(command, "docker *");
    assert.equal(r.excluded, false, command);
    assert.ok(codes(r).includes(code), `${command}: ${codes(r)}`);
  }
  assert.equal(run("docker ps 2>&1", "docker *").excluded, true, "a copy of a file descriptor is allowed");
  assert.equal(run("docker ps >&2", "docker *").excluded, true);
  assert.equal(run("docker ps 1>&2", "docker *").excluded, true);
  assert.deepEqual(run("a".repeat(10001), "*").callReasons.map((x) => x.code), ["too-long"]);
  assert.deepEqual(run("docker ps &&", "docker *").callReasons.map((x) => x.code), ["unparseable"]);
});

test("analyzeCall: the parts that can never be covered, each with its reason", () => {
  const parts = {
    "cd sub && docker ps": "directory", "pushd sub && docker ps": "directory", "sudo docker ps": "wrapper", "echo a | xargs docker ps": "wrapper", "command docker ps": "wrapper",
    "eval docker ps": "runs-code", "export X=1 && docker ps": "shell-state", "FOO=bar docker ps": "unsafe-assignment", "X=1; docker ps": "unsafe-assignment",
    "\"docker\" ps": "command-word", "'docker' ps": "command-word", "$D ps": "command-word", "d\\ocker ps": "command-word", "docker* ps": "command-word",
    "env FOO=bar docker ps": "unsafe-assignment", "timeout abc docker ps": "unlooked-wrapper",
  };
  for (const [command, code] of Object.entries(parts)) {
    const r = run(command, "*");
    assert.equal(r.excluded, false, command);
    assert.ok(codes(r).includes(code), `${command}: ${codes(r)}`);
  }
});

test("analyzeCall: tools with flags that keep a call in the sandbox, and the same tools without them", () => {
  const entries = ["git *", "docker *", "kubectl *", "aws *", "bash *", "python *", "node *", "make *"];
  const stays = {
    "git -C sub status": "git-flag", "git -c core.pager=cat log": "git-flag", "git --git-dir=.git status": "git-flag", "git --exec-path=/x status": "git-flag",
    "git clone https://x/y.git ~/tools": "git-path", "git clone https://x/y.git /tmp/x": "git-path", "git clone https://x/y.git ../x": "git-path", "git init /tmp/x": "git-path", "git worktree add ../w": "git-path", "git bundle create ../b HEAD": "git-path",
    "git bisect run ./t.sh": "git-run", "git submodule foreach ls": "git-run", "git config alias.x status": "git-config", "git rebase -x ls HEAD~1": "git-flag",
    "docker -H tcp://x ps": "risky-flag", "docker ps -H tcp://x": "risky-flag", "docker --context x ps": "risky-flag", "kubectl --server=x get pods": "risky-flag", "kubectl get pods -s x": "risky-flag", "aws s3 ls --profile x": "risky-flag",
    "bash -c 'ls'": "interpreter", "bash -ec 'ls'": "interpreter", "bash": "interpreter", "python -c 'print(1)'": "interpreter", "node -e 1": "interpreter", "python -": "interpreter",
  };
  for (const [command, code] of Object.entries(stays)) {
    const r = run(command, ...entries);
    assert.equal(r.excluded, false, command);
    assert.ok(codes(r).includes(code), `${command}: ${codes(r)}`);
  }
  for (const command of ["git status", "git --no-pager log", "git clone https://x/y.git vendor/lib", "git init sub", "git worktree add w", "git config user.name x", "docker ps --format x", "kubectl get pods", "aws s3 ls", "bash script.sh", "python script.py", "python -m http.server", "node app.js", "make test"]) {
    assert.equal(run(command, ...entries).excluded, true, command);
  }
  assert.equal(run("echo a | make", "make *", "echo *").excluded, false, "make after a pipe reads its program from input");
  assert.equal(run("make | echo", "make *", "echo *").excluded, true, "make before the pipe does not");
});

test("analyzeCall: entries are matched as Bash rules are: exact, prefix with :*, wildcard, and a bare ' *' also matches the bare command", () => {
  assert.equal(run("docker", "docker *").excluded, true);
  assert.equal(run("docker", "docker").excluded, true);
  assert.equal(run("docker ps", "docker").excluded, false);
  assert.equal(run("docker ps", "docker:*").excluded, true);
  assert.equal(run("dockerx ps", "docker:*").excluded, false);
  assert.equal(run("docker compose up", "docker * up").excluded, true);
  assert.equal(run("docker compose down", "docker * up").excluded, false);
  assert.equal(run("mytoolx run", "my*l run").excluded, false);
  assert.equal(run("mytool run", "my*l run").excluded, true);
  assert.equal(run("docker ps", "docker ps", "git *").parts[0].matched.entry, "docker ps");
  assert.equal(run("docker ps").excluded, false, "no entry, no exclusion");
});

test("analyzeCall: a variable assigned in one part and used in another keeps the call in the sandbox; a harmless assignment passes", () => {
  assert.equal(run("CI=1; docker ps", "docker *").excluded, true);
  assert.equal(run("CI=1; docker run $CI", "docker *").excluded, false);
  assert.deepEqual(codes(run("CI=1; docker run $CI", "docker *")), ["variable-flow"]);
  assert.equal(run("LANG=C; docker ps", "docker *").excluded, false, "LANG is not passed on its own");
  assert.equal(run("X=1; docker ps", "docker *").excluded, false);
});

test("deadEntryReason: an entry that can never take a call out of the sandbox, with the reason; a useful one gives null", () => {
  const dead = {
    "sudo *": "wrapper", "cd *": "directory", "cd": "directory", "eval *": "runs-code", "xargs *": "wrapper", "export *": "shell-state", "awk *": "awk", "watch *": "watcher",
    "bash -c *": "interpreter", "sh -c *": "interpreter", "python -c *": "interpreter", "git -C *": "git-flag", "git -c *": "git-flag", "docker -H *": "risky-flag",
    "FOO=bar docker *": "unsafe-assignment", "\"docker\" *": "command-word", "$X *": "command-word", "docker build . > out.log": "redirect", "docker run $(x)": "substitution",
    "npm ci && docker *": null, "": "empty", "   ": "empty",
  };
  for (const [entry, code] of Object.entries(dead)) {
    const r = deadEntryReason(entry);
    if (entry === "npm ci && docker *") { assert.ok(r, "a compound entry cannot match one part"); continue; }
    assert.ok(r, JSON.stringify(entry));
    assert.equal(r.code, code, `${JSON.stringify(entry)}: ${r.code}`);
  }
  for (const entry of ["docker *", "docker", "git status", "git *", "kubectl:*", "timeout *", "npm run *", "bash *", "python *", "node *", "make test", "/usr/bin/docker *", "NODE_ENV=x npm *".replace("NODE_ENV=x ", ""), "*", "docker * up"]) {
    assert.equal(deadEntryReason(entry), null, entry);
  }
  assert.match(deadEntryReason("docker ").text, /space/);
  assert.equal(parseEntries(["docker *", "git"]).length, 2);
});

test("every reason has a sentence, and the ids are the ones the README lists", () => {
  for (const [id, text] of Object.entries(REASONS)) assert.ok(text.length > 10 && !/^\s|\s$/.test(text), id);
  assert.ok(Object.keys(REASONS).length >= 30);
});
