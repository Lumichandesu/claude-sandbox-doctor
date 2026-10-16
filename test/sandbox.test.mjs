// The merge of the sandbox settings: the winner of a value and what it shadows, the joined lists with their files, the keys only some
// files may set, the admin-required lock, enabledPlatforms, the strict retry, and what permission rules add to the sandbox.
import test from "node:test";
import assert from "node:assert/strict";
import { world } from "./helpers.mjs";
import { loadSettings } from "../src/settings.mjs";
import { blockReadsOf, claudePlatform, honoredFrom, mergeSandbox } from "../src/sandbox.mjs";

const load = (w) => loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, platform: "linux" });
const merge = (w, platform = "linux") => mergeSandbox(load(w), { platform });
const names = (list) => list.filter((it) => it.sources.length).map((it) => it.value);

test("a plain value is the one the highest file sets, and what it shadows is listed with its file", () => {
  const w = world("win");
  w.user({ sandbox: { enabled: false, failIfUnavailable: true } });
  w.project({ sandbox: { enabled: true } });
  w.local({ sandbox: { enabled: false } });
  const m = merge(w);
  assert.equal(m.values.enabled.winner.value, false);
  assert.equal(m.values.enabled.winner.source.scope, "local");
  assert.deepEqual(m.values.enabled.shadowed.map((s) => [s.source.scope, s.value]), [["project", true]], "the user's false equals the winner, so only the project's true is shadowed");
  assert.equal(m.effective.enabled, false);
  assert.equal(m.values.failIfUnavailable.winner.source.scope, "user");
});

test("managed settings win over every other file", () => {
  const w = world("managedwins");
  w.managed({ sandbox: { enabled: true } });
  w.local({ sandbox: { enabled: false } });
  assert.equal(merge(w).effective.enabled, true);
  assert.equal(merge(w).values.enabled.winner.source.scope, "managed");
});

test("a list is the items of every file, an item that two files hold counted once with both files", () => {
  const w = world("lists");
  w.user({ sandbox: { excludedCommands: ["docker *", "git status"] } });
  w.project({ sandbox: { excludedCommands: ["docker *", "make *"] } });
  const m = merge(w);
  assert.deepEqual(names(m.lists.excludedCommands).sort(), ["docker *", "git status", "make *"]);
  const docker = m.lists.excludedCommands.find((i) => i.value === "docker *");
  assert.deepEqual(docker.sources.map((s) => s.scope).sort(), ["project", "user"]);
  assert.equal(m.effective.excludedCommands.length, 3);
});

test("a key that only user and managed settings may set is left out of a project file; a managed-only key out of a user file", () => {
  const w = world("scope");
  w.project({ sandbox: { allowAppleEvents: true, filesystem: { disabled: true }, network: { strictAllowlist: true } } });
  w.user({ sandbox: { bwrapPath: "/opt/bwrap", enabledPlatforms: ["macos"], network: { allowManagedDomainsOnly: true } } });
  const m = merge(w);
  for (const key of ["allowAppleEvents", "filesystem.disabled", "network.strictAllowlist", "bwrapPath", "enabledPlatforms", "network.allowManagedDomainsOnly"]) {
    assert.equal(m.values[key].winner, null, key);
    assert.match(m.values[key].set[0].ignored, /only/, key);
  }
  assert.equal(m.effective.platformListed, true, "enabledPlatforms in a user file does not leave this system out");
  assert.equal(m.effective.adminRequired, false);
  assert.equal(honoredFrom("allowAppleEvents", "project"), false);
  assert.equal(honoredFrom("allowAppleEvents", "user"), true);
  assert.equal(honoredFrom("bwrapPath", "user"), false);
  assert.equal(honoredFrom("bwrapPath", "managed"), true);
  assert.equal(honoredFrom("excludedCommands", "project"), true);
});

test("enabledPlatforms in managed settings leaves a system out: the sandbox settings are inert there", () => {
  const w = world("platforms");
  w.managed({ sandbox: { enabledPlatforms: ["macos"] } });
  w.user({ sandbox: { enabled: true } });
  for (const [platform, listed] of [["linux", false], ["wsl2", false], ["macos", true], ["windows", false]]) {
    const m = merge(w, platform);
    assert.equal(m.effective.platformListed, listed, platform);
    assert.equal(m.effective.enabled, listed, platform);
  }
  assert.match(merge(w).notes[0], /enabledPlatforms \["macos"\] without linux/);
  assert.equal(claudePlatform("wsl2"), "wsl");
  assert.equal(claudePlatform("wsl1"), "wsl");
  const none = world("platforms-none");
  none.managed({ sandbox: { enabledPlatforms: [] } });
  none.user({ sandbox: { enabled: true } });
  assert.equal(merge(none).effective.enabled, false, "an empty list leaves every system out");
});

test("a false allowUnsandboxedCommands in user or managed settings holds against a project's true; a project's own false counts", () => {
  const a = world("strict-a");
  a.user({ sandbox: { allowUnsandboxedCommands: false } });
  a.project({ sandbox: { allowUnsandboxedCommands: true } });
  const ma = merge(a).effective;
  assert.equal(ma.allowUnsandboxedCommands, false);
  assert.deepEqual(ma.strictBy.map((s) => s.scope), ["user"]);
  const b = world("strict-b");
  b.project({ sandbox: { allowUnsandboxedCommands: false } });
  assert.equal(merge(b).effective.allowUnsandboxedCommands, false);
  assert.deepEqual(merge(b).effective.strictBy.map((s) => s.scope), ["project"]);
  const c = world("strict-c");
  c.user({ sandbox: { enabled: true } });
  assert.equal(merge(c).effective.allowUnsandboxedCommands, true);
  assert.equal(merge(c).effective.autoAllowBashIfSandboxed, true);
});

test("a sandbox made admin-required by managed settings ignores a repository's entries, and a repository's true for the weaker modes", () => {
  const w = world("admin");
  w.managed({ sandbox: { enabled: true, allowUnsandboxedCommands: false, excludedCommands: ["make *"] } });
  w.project({ sandbox: { excludedCommands: ["docker *"], enableWeakerNestedSandbox: true, network: { allowedDomains: ["a.com"] }, filesystem: { allowWrite: ["./out"] } } });
  w.user({ sandbox: { excludedCommands: ["gh *"], network: { allowedDomains: ["b.com"] } } });
  const m = merge(w);
  assert.equal(m.effective.adminRequired, true);
  assert.match(m.effective.adminReasons[0], /allowUnsandboxedCommands to false/);
  assert.deepEqual(names(m.lists.excludedCommands).sort(), ["gh *", "make *"]);
  assert.deepEqual(names(m.lists["network.allowedDomains"]), ["b.com"]);
  assert.deepEqual(names(m.lists["filesystem.allowWrite"] || []), []);
  assert.match(m.lists.excludedCommands.find((i) => i.value === "docker *").ignored[0].reason, /admin-required/);
  assert.match(m.values.enableWeakerNestedSandbox.set[0].ignored, /admin-required/);
  assert.equal(m.effective.ignoredExcluded.length, 1);
});

test("allowManagedDomainsOnly in managed settings also makes the sandbox admin-required", () => {
  const w = world("admin-domains");
  w.managed({ sandbox: { network: { allowManagedDomainsOnly: true } } });
  w.project({ sandbox: { excludedCommands: ["docker *"] } });
  const m = merge(w);
  assert.equal(m.effective.adminRequired, true);
  assert.deepEqual(names(m.lists.excludedCommands), []);
});

test("an admin-required sandbox lets a repository's false for enabled lose to the user's true", () => {
  const w = world("admin-enabled");
  w.managed({ sandbox: { allowUnsandboxedCommands: false } });
  w.user({ sandbox: { enabled: true } });
  w.project({ sandbox: { enabled: false } });
  assert.equal(merge(w).effective.enabled, true);
  const w2 = world("not-admin-enabled");
  w2.user({ sandbox: { enabled: true } });
  w2.project({ sandbox: { enabled: false } });
  assert.equal(merge(w2).effective.enabled, false, "without the lock the project's false wins over the user's true");
});

test("permission rules reach the sandbox: Edit and Read rules, WebFetch domains, extra folders, and the read block", () => {
  const w = world("derived");
  w.user({ permissions: { blockReadsOutsideWorkingDirectories: true, allow: ["Edit(./build/**)", "WebFetch(domain:github.com)"], deny: ["Read(./.env)", "Edit(./dist/**)", "WebFetch(domain:evil.test)"], additionalDirectories: ["../shared"] } });
  w.project({ permissions: { blockReadsOutsideWorkingDirectories: false } });
  const m = merge(w);
  assert.deepEqual(m.derived.allowWrite.map((x) => x.rule), ["Edit(./build/**)"]);
  assert.deepEqual(m.derived.denyWrite.map((x) => x.rule), ["Edit(./dist/**)"]);
  assert.deepEqual(m.derived.denyRead.map((x) => x.rule), ["Read(./.env)"]);
  assert.deepEqual(m.derived.allowedDomains.map((x) => x.content), ["github.com"]);
  assert.deepEqual(m.derived.deniedDomains.map((x) => x.content), ["evil.test"]);
  assert.deepEqual(m.derived.additionalDirectories.map((x) => x.value), ["../shared"]);
  assert.equal(m.effective.blockReads.on, true);
  assert.deepEqual(blockReadsOf(load(w)).sources.map((s) => s.scope), ["user"], "a false in the project file is the same as unset");
});

test("a file Claude Code ignores contributes nothing to the merge", () => {
  const w = world("ignored-merge");
  w.write(w.projectFile, '{ // c\n "sandbox": { "enabled": true, "excludedCommands": ["docker *"] } }');
  w.user({ sandbox: { excludedCommands: ["gh *"] } });
  const m = merge(w);
  assert.equal(m.effective.enabledInSettings, false);
  assert.deepEqual(names(m.lists.excludedCommands), ["gh *"]);
  assert.equal(m.files.find((f) => f.scope === "project").ignored.reason, "not-json");
});
