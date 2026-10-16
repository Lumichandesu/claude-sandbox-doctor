// What the real Claude Code does with sandbox settings that `lint` calls dead, on Linux with bubblewrap and on macOS, at zero
// tokens: a file with a comment, a key that is none, a key that only managed settings may set, an allowWrite entry for a path the
// sandbox keeps write-protected, a wildcard in an allowWrite entry. Each test also asks `lint` about the same files, so that the
// finding and the behaviour are held to each other.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { claudeInfo, put, skip, IS_WIN } from "./claude-sandbox.mjs";
import { runSession } from "./oracle.mjs";
import { run, world } from "./helpers.mjs";

const SKIP = skip() || (IS_WIN && "the Bash sandbox exists on Linux, WSL2 and macOS only");
const LINUX = process.platform === "linux";
const ids = async (files) => {
  const w = world("keys-lint");
  for (const [scope, value] of Object.entries(files)) w[scope](value);
  const j = (await run(["lint", "--json"], w)).json();
  return j.findings.map((f) => f.id);
};

test("a user file with a comment, a trailing comma or a value of the wrong type in its sandbox block is ignored whole: the sandbox it switches on stays off", { skip: SKIP, timeout: 300000 }, async () => {
  const commented = '{\n  // the sandbox\n  "sandbox": { "enabled": true }\n}\n';
  const trailing = '{ "sandbox": { "enabled": true }, }\n';
  const a = await runSession({ label: "comment", user: commented, project: {}, commands: ["mytool run"] });
  const b = await runSession({ label: "trailing", user: trailing, project: {}, commands: ["mytool run"] });
  const wrongType = await runSession({ label: "wrong-type", user: { sandbox: { enabled: true, excludedCommands: "mytool" } }, project: {}, commands: ["mytool run"] });
  const c = await runSession({ label: "plain", user: '{ "sandbox": { "enabled": true } }\n', project: {}, commands: ["mytool run"] });
  assert.deepEqual(a.places, ["unsandboxed"], "a comment: the file is ignored");
  assert.deepEqual(b.places, ["unsandboxed"], "a trailing comma: the file is ignored");
  assert.deepEqual(wrongType.places, ["unsandboxed"], "excludedCommands as a string: the file is ignored, and so is its enabled");
  assert.deepEqual(c.places, ["sandboxed"], "the same without any of them: the sandbox is on");
  assert.ok((await ids({ user: commented })).includes("file-ignored"));
  assert.ok((await ids({ user: trailing })).includes("file-ignored"));
  assert.ok((await ids({ user: { sandbox: { enabled: true, excludedCommands: "mytool" } } })).includes("file-ignored"));
});

test("a key that is none does nothing, with no warning: excludedCommand for excludedCommands", { skip: SKIP, timeout: 300000 }, async () => {
  const typo = await runSession({ label: "typo", user: { sandbox: { enabled: true, excludedCommand: ["mytool *"] } }, project: {}, commands: ["mytool run"] });
  const right = await runSession({ label: "right", user: { sandbox: { enabled: true, excludedCommands: ["mytool *"] } }, project: {}, commands: ["mytool run"] });
  assert.deepEqual(typo.places, ["sandboxed"]);
  assert.deepEqual(right.places, ["unsandboxed"]);
  assert.equal(typo.result.subtype, "success");
  assert.ok((await ids({ user: { sandbox: { enabled: true, excludedCommand: ["mytool *"] } } })).includes("unknown-key"));
});

test("a key that only managed settings may set does nothing in a user file: enabledPlatforms naming another system, and network.allowManagedDomainsOnly", { skip: SKIP, timeout: 300000 }, async (t) => {
  // enabledPlatforms in a user file: the sandbox stays on here
  const platforms = await runSession({ label: "platforms", user: { sandbox: { enabled: true, enabledPlatforms: ["windows"] } }, project: {}, commands: ["mytool run"] });
  assert.deepEqual(platforms.places, ["sandboxed"]);
  // allowManagedDomainsOnly in a user file does not make the sandbox admin-required: the project's excludedCommands still counts
  const managedOnly = await runSession({ label: "managed-only", user: { sandbox: { enabled: true, network: { allowManagedDomainsOnly: true } } }, project: { sandbox: { excludedCommands: ["mytool *"] } }, commands: ["mytool run"] });
  assert.deepEqual(managedOnly.places, ["unsandboxed"]);
  const found = await ids({ user: { sandbox: { enabled: true, enabledPlatforms: ["windows"], network: { allowManagedDomainsOnly: true } } } });
  assert.equal(found.filter((id) => id === "key-scope").length, 2);
  t.diagnostic(`Claude Code ${claudeInfo().version}: enabledPlatforms and allowManagedDomainsOnly in a user file changed nothing`);
});

test("an allowWrite entry does not lift the protection of .mcp.json and .claude/settings.json: the write fails with or without it", { skip: SKIP, timeout: 300000 }, async (t) => {
  const seen = [];
  for (const withEntries of [false, true]) {
    const r = await runSession({
      label: withEntries ? "protected-allow" : "protected-plain",
      project: {},
      commands: ["printf x >> notes.txt; echo rc=$?", "printf x >> .mcp.json; echo rc=$?", "printf x >> .claude/settings.json; echo rc=$?"],
      setup: (sb) => {
        put(path.join(sb.work, "notes.txt"), "n\n");
        put(path.join(sb.work, ".mcp.json"), "{}\n");
        const w = (rel) => path.join(sb.work, rel);
        put(sb.user, { sandbox: { enabled: true, ...(withEntries ? { filesystem: { allowWrite: [w(".mcp.json"), w(".claude/settings.json")] } } : {}) } });
      },
      user: undefined,
    });
    const [notes, mcp, settings] = r.calls.map((c) => c.text);
    assert.match(notes, /rc=0/, "an ordinary file in the project folder can be written");
    assert.match(mcp, /rc=[1-9]/, ".mcp.json cannot");
    assert.match(settings, /rc=[1-9]/, ".claude/settings.json cannot");
    assert.equal(fs.readFileSync(path.join(r.sb.work, ".mcp.json"), "utf8"), "{}\n");
    assert.equal(fs.readFileSync(path.join(r.sb.work, "notes.txt"), "utf8"), "n\nx");
    seen.push(`${withEntries ? "with" : "without"} the entries: ${JSON.stringify(mcp.replace(/\s+/g, " ").slice(0, 120))}`);
  }
  t.diagnostic(`Claude Code ${claudeInfo().version}: ${seen.join("; ")}`);
  const w = world("protected-lint");
  w.user({ sandbox: { enabled: true, filesystem: { allowWrite: [path.join(w.work, ".mcp.json")] } } });
  const j = (await run(["lint", "--json"], w)).json();
  assert.ok(j.findings.some((f) => f.id === "protected-path"));
});

test("a wildcard in an allowWrite entry: on Linux the sandbox mounts concrete paths, so the entry gives nothing (what macOS does is recorded)", { skip: SKIP, timeout: 300000 }, async (t) => {
  // the world is made inside runSession, so the folders are made through its setup hook
  let home;
  const res = await runSession({
    label: "glob",
    project: {},
    programs: [],
    commands: ["touch $CSD_HOME/exact-dir/ok; echo rc=$?", "touch $CSD_HOME/glob-a/ok; echo rc=$?", "touch $CSD_HOME/gfile-1; echo rc=$?"],
    setup: (s) => {
      home = s.home;
      fs.mkdirSync(path.join(home, "exact-dir"), { recursive: true });
      fs.mkdirSync(path.join(home, "glob-a"), { recursive: true });
      put(s.user, { sandbox: { enabled: true, filesystem: { allowWrite: [path.join(home, "exact-dir"), path.join(home, "glob-*"), path.join(home, "gfile-*")] } } });
    },
    user: undefined,
    env: (s) => ({ CSD_HOME: s.home }),
  });
  const wrote = { exact: fs.existsSync(path.join(home, "exact-dir", "ok")), inFolder: fs.existsSync(path.join(home, "glob-a", "ok")), file: fs.existsSync(path.join(home, "gfile-1")) };
  const say = (n) => JSON.stringify(res.calls[n].text.replace(/\s+/g, " ").slice(0, 110));
  t.diagnostic(`Claude Code ${claudeInfo().version} on ${process.platform}: an exact allowWrite path wrote: ${wrote.exact}; a file inside a folder that a wildcard entry matches: ${wrote.inFolder} (${say(1)}); a new file whose name a wildcard entry matches: ${wrote.file} (${say(2)})`);
  assert.equal(wrote.exact, true, "the exact path is writable");
  if (LINUX) {
    assert.equal(wrote.inFolder, false, "the wildcard entry is skipped on Linux");
    assert.equal(wrote.file, false, "and so is the one for a new file");
    assert.ok((await ids({ user: { sandbox: { enabled: true, filesystem: { allowWrite: [path.join(home, "glob-*")] } } } })).includes("write-glob-linux"));
  }
});
