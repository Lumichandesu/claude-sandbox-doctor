// The settings reader: which files are read, in which order, with which line for each key, and which a file Claude Code ignores.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { world, tmpDir, put } from "./helpers.mjs";
import { analyzeText, loadSettings } from "../src/settings.mjs";

const load = (w, extra = {}) => loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, platform: "linux", ...extra });

test("analyzeText: strict JSON is read; a comment, a trailing comma and a value that is not an object are what Claude Code ignores", () => {
  assert.equal(analyzeText('{"sandbox":{"enabled":true}}').ignored, false);
  assert.equal(analyzeText("").empty, true);
  for (const [text, kind] of [['{\n  // c\n  "a": 1\n}', "comment"], ['{"a": 1,}', "trailing-comma"], ["[1]", "not-object"], ['{"a": ', "syntax"], ["null", "not-object"], ['"x"', "not-object"]]) {
    const a = analyzeText(text);
    assert.equal(a.ignored, true, text);
    assert.equal(a.problems[0].kind, kind, text);
  }
  assert.equal(analyzeText('{\n  // c\n  "a": 1\n}').problems[0].line, 2);
});

test("the four files are read, highest precedence first, each with its place", () => {
  const w = world("order");
  w.user({ sandbox: { enabled: true } });
  w.project({ sandbox: { excludedCommands: ["docker *"] } });
  w.local({ sandbox: { autoAllowBashIfSandboxed: false } });
  w.managed({ sandbox: { failIfUnavailable: true } });
  const s = load(w);
  assert.deepEqual(s.files.map((f) => f.scope), ["managed", "local", "project", "user"]);
  assert.deepEqual(s.files.map((f) => f.exists), [true, true, true, true]);
  assert.deepEqual(s.files.map((f) => f.display), [path.join(w.managedDir, "managed-settings.json").split(path.sep).join("/"), ".claude/settings.local.json", ".claude/settings.json", "~/.claude/settings.json"]);
  const proj = s.files.find((f) => f.scope === "project");
  assert.deepEqual(Object.keys(proj.view.sandbox.entries), ["excludedCommands"]);
  assert.equal(proj.view.sandbox.entries.excludedCommands.items[0].value, "docker *");
});

test("a key and a list entry come with their lines", () => {
  const w = world("lines");
  w.write(w.userFile, '{\n  "model": "x",\n  "sandbox": {\n    "enabled": true,\n    "network": {\n      "allowedDomains": [\n        "a.com",\n        "b.com"\n      ]\n    }\n  }\n}\n');
  const s = load(w);
  const sb = s.files.find((f) => f.scope === "user").view.sandbox;
  assert.equal(sb.entries.enabled.line, 4);
  assert.equal(sb.entries["network.allowedDomains"].line, 6);
  assert.deepEqual(sb.entries["network.allowedDomains"].items.map((i) => [i.value, i.line]), [["a.com", 7], ["b.com", 8]]);
});

test("a file with a comment or a trailing comma is ignored whole: its sandbox keys count for nothing, and the reason is kept", () => {
  const w = world("ignored");
  w.write(w.projectFile, '{\n  // keep the sandbox on\n  "sandbox": { "enabled": true }\n}\n');
  w.write(w.localFile, '{ "sandbox": { "enabled": true, }, }');
  const s = load(w);
  const proj = s.files.find((f) => f.scope === "project");
  assert.equal(proj.ignored.reason, "not-json");
  assert.match(proj.ignored.detail, /a comment/);
  assert.equal(proj.ignored.line, 2);
  assert.match(s.files.find((f) => f.scope === "local").ignored.detail, /trailing comma/);
  assert.equal(proj.view.sandbox.entries.enabled.value, true, "the view keeps what the file would have said");
});

test("a value of the wrong type in the sandbox block drops the whole file (claude doctor: Expected boolean, but received string)", () => {
  const w = world("wrongtype");
  w.user({ sandbox: { enabled: "yes" } });
  w.project({ sandbox: { excludedCommands: "docker" } });
  w.local({ sandbox: { network: { allowedDomains: [1] } } });
  const s = load(w);
  for (const f of s.files.filter((x) => x.exists)) assert.equal(f.ignored.reason, "wrong-type", f.scope);
  assert.match(s.files.find((f) => f.scope === "user").ignored.detail, /sandbox\.enabled is string, and Claude Code wants boolean/);
  assert.match(s.files.find((f) => f.scope === "project").ignored.detail, /excludedCommands is string, and Claude Code wants array of strings/);
});

test("keys the sandbox block does not have are listed as unknown; a key a file may not set is still read", () => {
  const w = world("unknown");
  w.user({ sandbox: { enabled: true, enableWeakerNestedSandbx: true, network: { allowedDomain: [] }, bwrapPath: "/usr/bin/bwrap" } });
  const f = load(w).files.find((x) => x.scope === "user");
  assert.deepEqual(f.view.sandbox.unknown.map((u) => u.path).sort(), ["enableWeakerNestedSandbx", "network.allowedDomain"]);
  assert.equal(f.view.sandbox.entries.bwrapPath.value, "/usr/bin/bwrap");
  assert.equal(f.ignored, null);
});

test("managed drop-in files rank above managed-settings.json (they are merged on top of it), and the permissions block gives the read block, rules and folders", () => {
  const w = world("managed");
  w.managed({ sandbox: { enabled: true } });
  put(path.join(w.managedDir, "managed-settings.d", "10-extra.json"), { sandbox: { failIfUnavailable: true } });
  w.user({ permissions: { blockReadsOutsideWorkingDirectories: true, deny: ["Read(./secrets/**)"], allow: ["Edit(./out/**)"], additionalDirectories: ["../shared"] } });
  const s = load(w);
  assert.deepEqual(s.files.filter((f) => f.scope === "managed").map((f) => f.label), ["managed settings (10-extra.json)", "managed settings"]);
  const user = s.files.find((f) => f.scope === "user");
  assert.equal(user.view.permissions.blockReads.value, true);
  assert.deepEqual(user.view.permissions.deny.map((r) => r.raw), ["Read(./secrets/**)"]);
  assert.deepEqual(user.view.permissions.additionalDirectories.map((d) => d.value), ["../shared"]);
  assert.equal(s.rules.length, 2);
});

test("a project folder with spaces and a config folder given by CLAUDE_CONFIG_DIR are handled", () => {
  const base = tmpDir("csd-spaces-");
  const work = path.join(base, "my project", "sub dir");
  const cfg = path.join(base, "my config");
  put(path.join(work, ".claude", "settings.json"), { sandbox: { enabled: true } });
  put(path.join(cfg, "settings.json"), { sandbox: { excludedCommands: ["make *"] } });
  const s = loadSettings({ project: work, env: { CLAUDE_CONFIG_DIR: cfg, HOME: base, USERPROFILE: base }, home: base, managed: path.join(base, "none"), platform: "linux" });
  assert.equal(s.configDir, cfg);
  assert.equal(s.files.find((f) => f.scope === "project").view.sandbox.entries.enabled.value, true);
  assert.equal(s.files.find((f) => f.scope === "user").view.sandbox.entries.excludedCommands.items[0].value, "make *");
});
