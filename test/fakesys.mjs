// A machine that is not the one the tests run on: the `sys` object of src/host.mjs played from a description. The outputs of the
// real machines below were read from the CI logs of 16 October 2026 (GitHub's ubuntu-latest with Ubuntu 24.04.5 and kernel
// 6.17.0-1022-azure, and macos-latest with macOS 26.6.2).

/**
 * fakeSys({ platform, files, links, programs, runs, env, arch, release })
 *   files     { path: text }                 what readFile gives (and exists says yes to)
 *   links     { path: target }               symbolic links
 *   programs  { name: path }                 what which() finds
 *   runs      [[test, result]]               exec(file, args): the first row whose test (a string the command line contains, or a
 *                                            function of (file, args)) matches gives { status, stdout, stderr }; else exit 0
 */
export function fakeSys({ platform = "linux", files = {}, links = {}, programs = {}, runs = [], env = {}, arch = "x64", release = "6.17.0-1022-azure" } = {}) {
  const calls = [];
  return {
    platform, env, arch, release, calls,
    readFile(p) { if (Object.prototype.hasOwnProperty.call(files, p)) return files[p]; const e = new Error(`ENOENT ${p}`); e.code = "ENOENT"; throw e; },
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p) || Object.prototype.hasOwnProperty.call(links, p) || Object.values(programs).includes(p),
    isSymlink: (p) => Object.prototype.hasOwnProperty.call(links, p),
    readLink: (p) => (Object.prototype.hasOwnProperty.call(links, p) ? links[p] : null),
    which: (name) => programs[name] || null,
    exec(file, args) {
      const line = [file, ...args].join(" ");
      calls.push(line);
      for (const [test, result] of runs) {
        const hit = typeof test === "function" ? test(file, args) : line.includes(test);
        if (hit) return { status: 0, signal: null, stdout: "", stderr: "", error: null, ...result };
      }
      return { status: 0, signal: null, stdout: "", stderr: "", error: null };
    },
  };
}

const UBUNTU = {
  "/proc/version": "Linux version 6.17.0-1022-azure (buildd@lcy02-amd64-020) (x86_64-linux-gnu-gcc-13) #22-Ubuntu SMP Mon Jul 27 17:24:03 UTC 2026",
  "/etc/os-release": 'PRETTY_NAME="Ubuntu 24.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\n',
  "/proc/sys/kernel/osrelease": "6.17.0-1022-azure",
  "/proc/sys/kernel/unprivileged_userns_clone": "1\n",
  "/proc/sys/user/max_user_namespaces": "63838\n",
  "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
  "/proc/1/cgroup": "0::/init.scope\n",
};
const MERGED_USR = { "/bin": "usr/bin", "/lib": "usr/lib", "/lib64": "usr/lib64", "/sbin": "usr/sbin" };
const BWRAP_FAILS = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
const SETGROUPS_DENIED = "sh: 1: cannot create /proc/self/setgroups: Permission denied";

/** GitHub's ubuntu-latest with bubblewrap and socat installed: `profile` says whether the AppArmor profile for bwrap is there. */
export function ubuntu({ profile = false, bwrap = true, socat = true, env = {} } = {}) {
  const programs = { unshare: "/usr/bin/unshare", bash: "/usr/bin/bash", sh: "/usr/bin/sh", ...(bwrap ? { bwrap: "/usr/bin/bwrap" } : {}), ...(socat ? { socat: "/usr/bin/socat" } : {}) };
  const runs = [
    ["bwrap --version", { stdout: "bubblewrap 0.9.0\n" }],
    ["socat -V", { stdout: "socat by Gerhard Rieger and contributors - see www.dest-unreach.org\nsocat version 1.8.0.0 on 03 Jul 2026 12:45:49\n   running on Linux version #22-Ubuntu SMP\n" }],
    [(f, a) => a[0] === "-U" && f.endsWith("unshare"), { status: 2, stderr: SETGROUPS_DENIED }],
    [(f) => f.endsWith("bwrap") && !profile, { status: 1, stderr: BWRAP_FAILS }],
    [(f, a) => f.endsWith("bwrap") && profile && a.includes("--version") === false, { status: 0, stdout: "sandbox-doctor-ok\n" }],
  ];
  // the version call must come before the failing trial
  return fakeSys({ platform: "linux", files: UBUNTU, links: MERGED_USR, programs, runs, env });
}

export const MAC = () => fakeSys({ platform: "darwin", arch: "arm64", release: "25.6.0", files: { "/usr/bin/sandbox-exec": "" }, programs: {}, runs: [["sw_vers", { stdout: "26.6.2\n" }], ["sandbox-exec", { status: 0 }]] });
export const WINDOWS = () => fakeSys({ platform: "win32", arch: "x64", release: "10.0.26300" });

export { UBUNTU as UBUNTU_FILES, BWRAP_FAILS, SETGROUPS_DENIED, MERGED_USR };
