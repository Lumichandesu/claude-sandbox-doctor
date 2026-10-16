// What this machine offers the Bash sandbox: the system, the programs Claude Code starts (bubblewrap and socat on Linux and
// WSL2, sandbox-exec on macOS), and a few trial runs that show whether the sandbox can start here. It does not run Claude Code
// (`--live`, src/live.mjs, does).
//
// The trial runs start only the programs named below, with the same kind of mounts Claude Code uses (read from the
// bubblewrap command line of Claude Code 2.1.301 on Ubuntu 24.04 in CI: `--new-session --die-with-parent --unshare-net
// --ro-bind / / --dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc`), and they change nothing on the machine.
// Every system call goes through the `sys` object, so the tests can play a machine that is not the one they run on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** The real machine, as the functions below ask for it. */
export function realSys(env = process.env) {
  return {
    platform: process.platform,
    env,
    arch: os.arch(),
    release: os.release(),
    readFile: (p) => fs.readFileSync(p, "utf8"),
    exists: (p) => fs.existsSync(p),
    isSymlink: (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } },
    readLink: (p) => { try { return fs.readlinkSync(p); } catch { return null; } },
    which(name) {
      const dirs = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
      for (const d of dirs) {
        const p = path.join(d, name);
        try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
      }
      return null;
    },
    exec(file, args, { timeout = 15000 } = {}) {
      const r = spawnSync(file, args, { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...env, LC_ALL: "C" } });
      return { status: r.status, signal: r.signal, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error ? String(r.error.code || r.error.message) : null };
    },
  };
}

const first = (s) => String(s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
const tryRead = (sys, p) => { try { return sys.readFile(p).trim(); } catch { return null; } };

/**
 * { id, label, claude, hasSandbox, detail }: "linux", "wsl1", "wsl2", "macos", "windows", or "other". `claude` is the name Claude
 * Code uses for it in `enabledPlatforms` (linux, wsl, macos, windows).
 */
export function detectPlatform(sys) {
  if (sys.platform === "win32") return { id: "windows", label: "Windows", claude: "windows", hasSandbox: false, detail: "" };
  if (sys.platform === "darwin") {
    const r = sys.exec("sw_vers", ["-productVersion"]);
    const v = r.status === 0 ? first(r.stdout) : "";
    return { id: "macos", label: v ? `macOS ${v}` : "macOS", claude: "macos", hasSandbox: true, detail: v };
  }
  if (sys.platform !== "linux") return { id: "other", label: sys.platform, claude: sys.platform, hasSandbox: false, detail: "" };
  const version = tryRead(sys, "/proc/version") || "";
  const osr = tryRead(sys, "/etc/os-release") || "";
  const pretty = (/^PRETTY_NAME="?([^"\n]+)"?/m.exec(osr) || [])[1] || "";
  const kernel = tryRead(sys, "/proc/sys/kernel/osrelease") || sys.release || "";
  if (/microsoft/i.test(version) || (sys.env && (sys.env.WSL_DISTRO_NAME || sys.env.WSL_INTEROP))) {
    const wsl2 = /WSL2/i.test(version) || (parseInt(String(kernel).split(".")[0], 10) >= 5);
    return { id: wsl2 ? "wsl2" : "wsl1", label: `${wsl2 ? "WSL2" : "WSL1"}${pretty ? `, ${pretty}` : ""}`, claude: "wsl", hasSandbox: wsl2, detail: kernel };
  }
  return { id: "linux", label: `Linux${pretty ? `, ${pretty}` : ""}`, claude: "linux", hasSandbox: true, detail: kernel };
}

const item = (id, status, title, extra = {}) => ({ id, status, title, ...extra });

/** The version line a program prints, or "". */
function versionOf(sys, file, args) {
  const r = sys.exec(file, args, { timeout: 8000 });
  return r.error ? "" : first(r.stdout || r.stderr);
}

/** What a failed bubblewrap run says, in words, with the fix. Returns { kind, text, fix, issue? } for an error text. */
export function explainBwrapError(text, { apparmorRestricts = false, userns = {} } = {}) {
  const t = String(text || "");
  if (/execvp .*: No such file or directory/.test(t)) {
    return { kind: "exec", text: "bubblewrap could not start the shell inside the sandbox (execvp: No such file or directory)", fix: "On a merged-usr system (/bin is a link to usr/bin) this happens when only /usr is mounted and the links are not recreated. It is anthropics/claude-code#99680. Run `claude-sandbox-doctor check --live` to see what Claude Code itself does here.", issue: "anthropics/claude-code#99680" };
  }
  if (/setting up uid map: Permission denied|loopback: Failed RTM_NEWADDR|No permissions to create new namespace|Creating new namespace failed|unshare: write failed/.test(t) || (apparmorRestricts && /Permission denied|Operation not permitted/.test(t))) {
    if (apparmorRestricts) return { kind: "apparmor", text: "AppArmor stops bubblewrap from creating a user namespace (kernel.apparmor_restrict_unprivileged_userns is 1 and there is no profile for bwrap)", fix: "Add an AppArmor profile that lets bwrap use user namespaces, as the sandboxing page of the Claude Code docs shows (/etc/apparmor.d/bwrap with `userns,`), then run `sudo systemctl reload apparmor`." };
    if (userns.clone === "0") return { kind: "userns-off", text: "user namespaces are switched off for unprivileged users (kernel.unprivileged_userns_clone is 0)", fix: "Run `sudo sysctl -w kernel.unprivileged_userns_clone=1`, and write it in /etc/sysctl.d to keep it." };
    if (userns.max === "0") return { kind: "userns-off", text: "the kernel allows no user namespaces (user.max_user_namespaces is 0)", fix: "Run `sudo sysctl -w user.max_user_namespaces=15000`, and write it in /etc/sysctl.d to keep it." };
    return { kind: "userns", text: "bubblewrap cannot create the namespaces it needs", fix: "Check that unprivileged user namespaces are allowed (kernel.unprivileged_userns_clone, user.max_user_namespaces, and on Ubuntu 23.10 and later kernel.apparmor_restrict_unprivileged_userns)." };
  }
  if (/Can't mount proc|Can't mount tmpfs|Can't mount devpts|mount .* Operation not permitted/.test(t)) {
    return { kind: "container", text: "bubblewrap cannot mount /proc here, which is what happens in an unprivileged container", fix: "Set sandbox.enableWeakerNestedSandbox to true (the sandbox then bind-mounts the container's /proc; it exposes process information that a fresh mount would hide), or run the container with the privileges bubblewrap needs." };
  }
  return { kind: "other", text: first(t) || "bubblewrap failed without a message", fix: "Run the command shown above by hand to see more." };
}

/** The sysctl values that bear on user namespaces: { clone, max, apparmor } as strings, or null when the file is not there. */
function userNamespaceSettings(sys) {
  return {
    clone: tryRead(sys, "/proc/sys/kernel/unprivileged_userns_clone"),
    max: tryRead(sys, "/proc/sys/user/max_user_namespaces"),
    apparmor: tryRead(sys, "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
  };
}

/** Is this a container? A hint from the files containers leave. */
function containerKind(sys) {
  if (sys.exists("/.dockerenv")) return "docker";
  if (sys.exists("/run/.containerenv")) return "podman";
  const cg = tryRead(sys, "/proc/1/cgroup") || "";
  if (/docker|kubepods|containerd|lxc|libpod/.test(cg)) return "container";
  if (sys.env && sys.env.container) return String(sys.env.container);
  return null;
}

/**
 * The checks of this machine.
 *   sys       realSys() or a play-acting machine
 *   settings  { bwrapPath, socatPath, enableWeakerNestedSandbox } from the merged sandbox settings, when they are known
 *   light     only what needs no trial run: the platform, the programs, the sysctls
 * Returns { platform, items, ok, hasSandbox, missing, summary }.
 */
export function checkHost(sys, { settings = {}, light = false } = {}) {
  const platform = detectPlatform(sys);
  const items = [];
  const out = { platform, items, ok: true, hasSandbox: platform.hasSandbox, missing: [], broken: false, summary: "" };
  const push = (it) => { items.push(it); if (it.status === "fail") out.ok = false; return it; };

  if (platform.id === "windows" || platform.id === "wsl1" || platform.id === "other") {
    push(item("platform", "info", platform.label, { detail: platform.detail }));
    push(item("no-sandbox", "ok", platform.id === "wsl1" ? "No Bash sandbox: Claude Code's sandbox needs WSL2, and this is WSL1" : platform.id === "windows" ? "No Bash sandbox on Windows: Claude Code runs Bash commands without one" : `No Bash sandbox is known for ${platform.label}`, {
      detail: platform.id === "windows" ? "The sandbox runs on Linux, WSL2 and macOS. With sandbox.enabled true on Windows, Claude Code 2.1.299 printed \"Sandbox disabled\" and ran commands without it; with failIfUnavailable true it refused to start (README: What was verified)." : "The sandbox runs on Linux, WSL2 and macOS.",
      fix: platform.id === "wsl1" ? "Upgrade the distribution to WSL2 (`wsl --set-version <distro> 2`) to get the sandbox." : "To use the sandbox on a Windows machine, run Claude Code inside a WSL2 distribution.",
    }));
    out.summary = "There is no Bash sandbox on this system. Nothing to check.";
    return out;
  }

  if (platform.id === "macos") {
    push(item("platform", "info", platform.label, { detail: `${sys.arch}` }));
    const se = sys.exists("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : sys.which("sandbox-exec");
    if (!se) {
      out.missing.push("sandbox-exec");
      push(item("sandbox-exec", "fail", "sandbox-exec is not there", { fix: "Claude Code's macOS sandbox builds on Seatbelt through /usr/bin/sandbox-exec, which ships with macOS. Check that it was not removed." }));
    } else if (light) {
      push(item("sandbox-exec", "ok", `sandbox-exec at ${se}`));
    } else {
      const r = sys.exec(se, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 10000 });
      if (r.status === 0) push(item("sandbox-exec", "ok", `Seatbelt works: sandbox-exec ran a command under a profile (${se})`));
      else {
        out.broken = true;
        const msg = first(r.stderr) || r.error || `exit ${r.status}`;
        push(item("sandbox-exec", "fail", `sandbox-exec could not apply a profile: ${msg}`, { fix: /sandbox_apply: Operation not permitted/.test(r.stderr) ? "This process already runs inside a sandbox, and Seatbelt does not nest here. Run claude outside the sandboxed program." : "Run `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` by hand to see the error." }));
      }
    }
    out.summary = out.ok ? "Seatbelt is there. The sandbox can start on this Mac." : "The sandbox cannot start on this Mac.";
    return out;
  }

  // Linux and WSL2
  push(item("platform", "info", platform.label, { detail: platform.detail ? `kernel ${platform.detail}` : "" }));
  const bw = settings.bwrapPath && path.isAbsolute(settings.bwrapPath) ? (sys.exists(settings.bwrapPath) ? settings.bwrapPath : null) : sys.which("bwrap");
  const so = settings.socatPath && path.isAbsolute(settings.socatPath) ? (sys.exists(settings.socatPath) ? settings.socatPath : null) : sys.which("socat");
  if (!bw) {
    out.missing.push("bwrap");
    push(item("bwrap", "fail", settings.bwrapPath ? `bubblewrap is not at ${settings.bwrapPath} (sandbox.bwrapPath)` : "bubblewrap (bwrap) is not installed", { fix: "Install it: `sudo apt-get install bubblewrap socat` (Debian, Ubuntu), `sudo dnf install bubblewrap socat` (Fedora)." }));
  } else {
    const v = versionOf(sys, bw, ["--version"]);
    push(item("bwrap", "ok", `${v || "bubblewrap"} at ${bw}`));
  }
  if (!so) {
    out.missing.push("socat");
    push(item("socat", "fail", settings.socatPath ? `socat is not at ${settings.socatPath} (sandbox.socatPath)` : "socat is not installed", { fix: "Install it: `sudo apt-get install socat` (Debian, Ubuntu), `sudo dnf install socat` (Fedora)." }));
  } else {
    const r = sys.exec(so, ["-V"], { timeout: 8000 });
    const line = (String(r.stdout).split("\n").find((l) => /^socat version/.test(l)) || first(r.stdout)).replace(/ on .*$/, "");
    push(item("socat", "ok", `${line || "socat"} at ${so}`));
  }
  const ns = userNamespaceSettings(sys);
  const nsDetail = [ns.clone !== null ? `kernel.unprivileged_userns_clone=${ns.clone}` : null, ns.max !== null ? `user.max_user_namespaces=${ns.max}` : null, ns.apparmor !== null ? `kernel.apparmor_restrict_unprivileged_userns=${ns.apparmor}` : null].filter(Boolean).join(", ");
  const apparmorRestricts = ns.apparmor === "1";
  const container = containerKind(sys);
  if (container) push(item("container", "info", `running inside a container (${container})`, { detail: settings.enableWeakerNestedSandbox === true ? "sandbox.enableWeakerNestedSandbox is true" : "" }));

  if (!bw || light) {
    push(item("namespaces", light ? "info" : "skip", `user namespaces: ${nsDetail || "no sysctl is readable"}`, { detail: light ? "" : "not tried: bubblewrap is missing" }));
    out.summary = out.ok ? "Bubblewrap and socat are there." : `Missing: ${out.missing.join(", ")}. The sandbox cannot start until they are installed.`;
    return out;
  }

  // trial 1: the mounts and namespaces Claude Code asks bubblewrap for
  const claudeArgs = ["--new-session", "--die-with-parent", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--unshare-user", "--cap-drop", "ALL", "--proc", "/proc", "--", "/bin/bash", "-c", "echo sandbox-doctor-ok"];
  const weaker = settings.enableWeakerNestedSandbox === true;
  const args = weaker ? claudeArgs.map((a) => a).filter((a) => a !== "--proc" && a !== "/proc").concat([]) : claudeArgs;
  const r = sys.exec(bw, weaker ? [...claudeArgs.slice(0, claudeArgs.indexOf("--proc")), "--bind", "/proc", "/proc", ...claudeArgs.slice(claudeArgs.indexOf("--proc") + 2)] : args, { timeout: 15000 });
  const shown = `bwrap ${claudeArgs.join(" ")}`;
  if (r.status === 0 && /sandbox-doctor-ok/.test(r.stdout)) {
    push(item("namespaces", "ok", "bubblewrap starts a shell with a user, process and network namespace and the host mounted read-only", { detail: `${nsDetail || "no sysctl is readable"}; the trial is ${shown}` }));
    const merged = sys.isSymlink("/bin") && /usr/.test(String(sys.readLink("/bin")));
    push(item("merged-usr", "ok", merged ? "/bin is a link to usr/bin (merged-usr), and /bin/bash runs inside the sandbox's mounts" : "/bin/bash runs inside the sandbox's mounts", { detail: merged ? "Claude Code mounts / as a whole, so the links survive; a sandbox that mounted only /usr would fail with \"execvp /bin/bash: No such file or directory\" (anthropics/claude-code#99680)." : "" }));
    // trial 2: a user namespace inside the sandbox, as the seccomp helper makes (anthropics/claude-code#43454)
    const un = sys.which("unshare");
    if (!un) push(item("setgroups", "skip", "writing /proc/self/setgroups in a nested user namespace was not tried", { detail: "unshare is not installed" }));
    else {
      const t2 = sys.exec(bw, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user", "--cap-drop", "ALL", "--", un, "-U", "sh", "-c", "echo deny > /proc/self/setgroups"], { timeout: 15000 });
      if (t2.status === 0) push(item("setgroups", "ok", "a user namespace inside the sandbox can write /proc/self/setgroups", { detail: "This is the step that failed in anthropics/claude-code#43454 (apply-seccomp: write /proc/self/setgroups: Permission denied)." }));
      else push(item("setgroups", "warn", `a user namespace inside the sandbox cannot write /proc/self/setgroups: ${first(t2.stderr) || `exit ${t2.status}`}`, { detail: "Claude Code's apply-seccomp helper does the same step to block Unix sockets; where it fails, commands fail with \"apply-seccomp: write /proc/self/setgroups\" (anthropics/claude-code#43454, 54 reactions on 16 October 2026). The step here is an approximation of the helper's.", fix: "Update Claude Code; the issue is open. Until it is fixed, take the commands out of the sandbox with excludedCommands or run Claude Code on a kernel where the nested namespace is allowed." }));
    }
  } else {
    out.broken = true;
    const text = `${r.stderr}${r.stdout}`.trim();
    const e = explainBwrapError(text, { apparmorRestricts, userns: { clone: ns.clone, max: ns.max } });
    push(item("namespaces", "fail", `bubblewrap cannot start a sandbox: ${first(text) || r.error || `exit ${r.status}`}`, { detail: `${e.text}. ${nsDetail ? `Seen: ${nsDetail}. ` : ""}The trial is ${shown}`, fix: e.fix, issue: e.issue || null }));
    if (e.kind === "exec") push(item("merged-usr", "fail", "/bin/bash does not run inside the mounts (execvp: No such file or directory)", { fix: e.fix, issue: e.issue }));
  }
  out.summary = out.ok ? "The sandbox can start on this machine." : out.missing.length ? `Missing: ${out.missing.join(", ")}.` : "The sandbox cannot start on this machine.";
  return out;
}
