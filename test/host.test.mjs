// The host checks, on machines that play the ones seen in CI: GitHub's ubuntu-latest before and after the AppArmor profile for
// bubblewrap, without bubblewrap, a container, a merged-usr failure, WSL1 and WSL2, macOS and Windows.
import test from "node:test";
import assert from "node:assert/strict";
import { checkHost, detectPlatform, explainBwrapError } from "../src/host.mjs";
import { BWRAP_FAILS, MAC, WINDOWS, fakeSys, ubuntu } from "./fakesys.mjs";

const byId = (r) => Object.fromEntries(r.items.map((i) => [i.id, i]));

test("detectPlatform: Linux, WSL1, WSL2, macOS and Windows are told apart", () => {
  assert.deepEqual(pick(detectPlatform(ubuntu())), { id: "linux", claude: "linux", hasSandbox: true });
  assert.equal(detectPlatform(ubuntu()).label, "Linux, Ubuntu 24.04.5 LTS");
  const wsl2 = fakeSys({ files: { "/proc/version": "Linux version 5.15.133.1-microsoft-standard-WSL2 (root@1)", "/proc/sys/kernel/osrelease": "5.15.133.1-microsoft-standard-WSL2" } });
  assert.deepEqual(pick(detectPlatform(wsl2)), { id: "wsl2", claude: "wsl", hasSandbox: true });
  const wsl1 = fakeSys({ files: { "/proc/version": "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)", "/proc/sys/kernel/osrelease": "4.4.0-19041-Microsoft" } });
  assert.deepEqual(pick(detectPlatform(wsl1)), { id: "wsl1", claude: "wsl", hasSandbox: false });
  assert.deepEqual(pick(detectPlatform(MAC())), { id: "macos", claude: "macos", hasSandbox: true });
  assert.equal(detectPlatform(MAC()).label, "macOS 26.6.2");
  assert.deepEqual(pick(detectPlatform(WINDOWS())), { id: "windows", claude: "windows", hasSandbox: false });
  assert.equal(detectPlatform(fakeSys({ platform: "freebsd" })).hasSandbox, false);
});
const pick = (p) => ({ id: p.id, claude: p.claude, hasSandbox: p.hasSandbox });

test("Windows and WSL1: there is no Bash sandbox, and that is not a failure", () => {
  for (const sys of [WINDOWS(), fakeSys({ files: { "/proc/version": "Linux version 4.4.0-19041-Microsoft", "/proc/sys/kernel/osrelease": "4.4.0-19041-Microsoft" } })]) {
    const r = checkHost(sys);
    assert.equal(r.ok, true);
    assert.equal(r.hasSandbox, false);
    assert.deepEqual(r.items.map((i) => i.id), ["platform", "no-sandbox"]);
    assert.match(r.summary, /no Bash sandbox/);
    assert.deepEqual(sys.calls, [], "nothing was started");
  }
  assert.match(byId(checkHost(WINDOWS()))["no-sandbox"].fix, /WSL2/);
});

test("ubuntu-latest as it comes: bubblewrap and socat are not there, and the check says what to install", () => {
  const r = checkHost(ubuntu({ bwrap: false, socat: false }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["bwrap", "socat"]);
  const items = byId(r);
  assert.equal(items.bwrap.status, "fail");
  assert.match(items.bwrap.fix, /sudo apt-get install bubblewrap socat/);
  assert.equal(items.namespaces.status, "skip");
  assert.match(r.summary, /Missing: bwrap, socat/);
});

test("ubuntu-latest with bubblewrap but without the AppArmor profile: every sandboxed command would fail, and the fix is the docs' profile", () => {
  const sys = ubuntu({ profile: false });
  const r = checkHost(sys);
  assert.equal(r.ok, false);
  assert.equal(r.broken, true);
  const items = byId(r);
  assert.equal(items.bwrap.status, "ok");
  assert.match(items.bwrap.title, /^bubblewrap 0\.9\.0 at \/usr\/bin\/bwrap$/);
  assert.match(items.socat.title, /^socat version 1\.8\.0\.0 at \/usr\/bin\/socat$/);
  assert.equal(items.namespaces.status, "fail");
  assert.match(items.namespaces.title, /bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted/);
  assert.match(items.namespaces.detail, /AppArmor stops bubblewrap from creating a user namespace/);
  assert.match(items.namespaces.detail, /kernel\.apparmor_restrict_unprivileged_userns=1/);
  assert.match(items.namespaces.fix, /\/etc\/apparmor\.d\/bwrap/);
  assert.equal(items.setgroups.status, "warn", "bubblewrap fails too, so the setgroups command is a warning");
  assert.ok(sys.calls.some((c) => /--unshare-net --ro-bind \/ \/ --dev \/dev --unshare-pid --unshare-user --cap-drop ALL --proc \/proc -- \/bin\/bash/.test(c)), "the trial has the mounts Claude Code uses");
});

test("ubuntu-latest with the profile: the sandbox can start, merged-usr is fine, and the setgroups command is only an info line", () => {
  const r = checkHost(ubuntu({ profile: true }));
  assert.equal(r.ok, true);
  const items = byId(r);
  assert.equal(items.namespaces.status, "ok");
  assert.equal(items["merged-usr"].status, "ok");
  assert.match(items["merged-usr"].title, /\/bin is a link to usr\/bin \(merged-usr\)/);
  assert.match(items["merged-usr"].detail, /#99680/);
  assert.equal(items.setgroups.status, "info", "unshare -U fails on this runner, and Claude Code still works there");
  assert.match(items.setgroups.title, /cannot write \/proc\/self\/setgroups here: sh: 1: cannot create \/proc\/self\/setgroups: Permission denied/);
  assert.match(items.setgroups.detail, /does not by itself stop the sandbox/);
  assert.match(r.summary, /can start/);
});

test("the light check starts nothing: the programs and the sysctls only", () => {
  const sys = ubuntu({ profile: false });
  const r = checkHost(sys, { light: true });
  assert.equal(r.ok, true);
  assert.deepEqual(sys.calls.filter((c) => /bwrap --new-session|unshare/.test(c)), []);
  assert.equal(byId(r).namespaces.status, "info");
  assert.deepEqual(checkHost(ubuntu({ bwrap: false }), { light: true }).missing, ["bwrap"]);
});

test("a container where bubblewrap cannot mount /proc: the fix is enableWeakerNestedSandbox, and with it on the trial binds /proc", () => {
  const files = { "/proc/version": "Linux version 6.8.0", "/etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 12"\n', "/.dockerenv": "", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n" };
  const programs = { bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat", unshare: "/usr/bin/unshare" };
  const runs = [["bwrap --version", { stdout: "bubblewrap 0.8.0\n" }], [(f, a) => f.endsWith("bwrap") && a.includes("--proc"), { status: 1, stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted" }], [(f, a) => f.endsWith("bwrap") && a.includes("--bind") && a.includes("/proc"), { stdout: "sandbox-doctor-ok\n" }]];
  const bad = checkHost(fakeSys({ files, programs, runs }));
  assert.equal(bad.ok, false);
  assert.match(byId(bad).namespaces.detail, /cannot mount \/proc here/);
  assert.match(byId(bad).namespaces.fix, /enableWeakerNestedSandbox/);
  assert.equal(byId(bad).container.status, "info");
  const good = fakeSys({ files, programs, runs });
  assert.equal(checkHost(good, { settings: { enableWeakerNestedSandbox: true } }).ok, true);
  assert.ok(good.calls.some((c) => c.includes("--bind /proc /proc")));
});

test("a sandbox that cannot run /bin/bash on a merged-usr system is the error of anthropics/claude-code#99680", () => {
  const files = { "/proc/version": "Linux version 6.12", "/etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 13"\n', "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n" };
  const runs = [["bwrap --version", { stdout: "bubblewrap 0.12.0\n" }], [(f) => f.endsWith("bwrap"), { status: 1, stderr: "bwrap: execvp /bin/bash: No such file or directory" }]];
  const r = checkHost(fakeSys({ files, links: { "/bin": "usr/bin" }, programs: { bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" }, runs }));
  assert.equal(r.ok, false);
  const items = byId(r);
  assert.equal(items["merged-usr"].status, "fail");
  assert.equal(items["merged-usr"].issue, "anthropics/claude-code#99680");
  assert.equal(items.namespaces.issue, "anthropics/claude-code#99680");
});

test("macOS: sandbox-exec is there and applies a profile; where it cannot, it says the process is already sandboxed", () => {
  const ok = checkHost(MAC());
  assert.equal(ok.ok, true);
  assert.match(byId(ok)["sandbox-exec"].title, /Seatbelt works/);
  const nested = MAC();
  nested.exec = () => ({ status: 71, signal: null, stdout: "", stderr: "sandbox-exec: sandbox_apply: Operation not permitted\n", error: null });
  nested.platform = "darwin";
  const bad = checkHost(Object.assign(nested, { exists: (p) => p === "/usr/bin/sandbox-exec" }));
  assert.equal(bad.ok, false);
  assert.match(byId(bad)["sandbox-exec"].fix, /already runs inside a sandbox/);
  const none = checkHost(fakeSys({ platform: "darwin", runs: [["sw_vers", { stdout: "15.0\n" }]] }));
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing, ["sandbox-exec"]);
});

test("a managed bwrapPath and socatPath are the ones looked for, and one that is not there is named", () => {
  const sys = fakeSys({ files: { "/proc/version": "Linux version 6.8.0", "/opt/admin/bwrap": "" }, programs: {}, runs: [["bwrap", { stdout: "sandbox-doctor-ok\n" }]] });
  const r = checkHost(sys, { settings: { bwrapPath: "/opt/admin/bwrap", socatPath: "/opt/admin/socat" } });
  const items = byId(r);
  assert.equal(items.bwrap.status, "ok");
  assert.equal(items.socat.status, "fail");
  assert.match(items.socat.title, /socat is not at \/opt\/admin\/socat \(sandbox\.socatPath\)/);
});

test("explainBwrapError names the cause of each error that was seen", () => {
  assert.equal(explainBwrapError("bwrap: setting up uid map: Permission denied", { apparmorRestricts: true }).kind, "apparmor");
  assert.equal(explainBwrapError(BWRAP_FAILS, { apparmorRestricts: false, userns: { clone: "0" } }).kind, "userns-off");
  assert.equal(explainBwrapError("bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.", { userns: { max: "0" } }).kind, "userns-off");
  assert.equal(explainBwrapError("bwrap: Can't mount proc on /newroot/proc: Operation not permitted").kind, "container");
  assert.equal(explainBwrapError("bwrap: execvp /bin/bash: No such file or directory").issue, "anthropics/claude-code#99680");
  assert.equal(explainBwrapError("something else\nmore").kind, "other");
  assert.equal(explainBwrapError("something else\nmore").text, "something else");
});
