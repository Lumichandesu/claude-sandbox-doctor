// What is known about the `sandbox` block, as tables: the keys, their types, which settings files honor them, and on which
// systems they do anything. Where each fact comes from is said next to it:
//   docs     code.claude.com/docs/en/sandboxing and /settings-reference, read on 16 October 2026
//   schema   SchemaStore's claude-code-settings.json (the 16 keys of the sandbox block)
//   binary   the claim was put to Claude Code (test/e2e-*.test.mjs); the README says which versions
//   claude doctor   what `claude doctor` printed for the setting (Claude Code 2.1.299, Windows)
// A fact marked docs only is a statement of the documentation that the binary was not asked about.

/**
 * Who may set a key. "any" is a user, project, local or managed file; "user" is the user's file, managed settings and the
 * --settings flag (a project or local file is ignored for it); "managed" is managed settings only.
 */
export const SCOPE_TEXT = {
  any: "any settings file",
  user: "user settings, managed settings and --settings (not project or local settings)",
  managed: "managed settings",
};

/**
 * The sandbox keys: type, who honors them, where they do anything. The key is the dotted path under `sandbox`. `verified` marks a
 * key whose scope was put to the binary (a user file's value did nothing, test/e2e-keys.test.mjs and test/e2e-bwrap.test.mjs, and
 * the managed one did something, test/e2e-managed.test.mjs).
 */
export const SANDBOX_KEYS = {
  "enabled": { type: "boolean", scope: "any" },
  "failIfUnavailable": { type: "boolean", scope: "any" },
  "autoAllowBashIfSandboxed": { type: "boolean", scope: "any" },
  "excludedCommands": { type: "strings", scope: "any", list: true },
  "allowUnsandboxedCommands": { type: "boolean", scope: "any" },
  "enableWeakerNestedSandbox": { type: "boolean", scope: "any", platforms: ["linux", "wsl"] },
  "enableWeakerNetworkIsolation": { type: "boolean", scope: "any", platforms: ["macos"] },
  "allowAppleEvents": { type: "boolean", scope: "user", platforms: ["macos"] },
  "bwrapPath": { type: "string", scope: "managed", platforms: ["linux", "wsl"], verified: true },
  "socatPath": { type: "string", scope: "managed", platforms: ["linux", "wsl"], verified: true },
  "enabledPlatforms": { type: "strings", scope: "managed", list: true, verified: true },
  "ignoreViolations": { type: "object" },
  "ripgrep": { type: "object", scope: "user" },
  "filesystem": { type: "object" },
  "filesystem.allowWrite": { type: "strings", scope: "any", list: true },
  "filesystem.denyWrite": { type: "strings", scope: "any", list: true },
  "filesystem.denyRead": { type: "strings", scope: "any", list: true },
  "filesystem.allowRead": { type: "strings", scope: "any", list: true },
  "filesystem.allowManagedReadPathsOnly": { type: "boolean", scope: "managed" },
  "filesystem.disabled": { type: "boolean", scope: "user" },
  "network": { type: "object" },
  "network.allowedDomains": { type: "strings", scope: "any", list: true },
  "network.deniedDomains": { type: "strings", scope: "any", list: true },
  "network.allowManagedDomainsOnly": { type: "boolean", scope: "managed", verified: true },
  "network.strictAllowlist": { type: "boolean", scope: "user", verified: true },
  "network.allowUnixSockets": { type: "strings", scope: "any", list: true, platforms: ["macos"] },
  "network.allowAllUnixSockets": { type: "boolean", scope: "any" },
  "network.allowLocalBinding": { type: "boolean", scope: "any", platforms: ["macos"] },
  "network.allowMachLookup": { type: "strings", scope: "any", list: true, platforms: ["macos"] },
  "network.httpProxyPort": { type: "port", scope: "any" },
  "network.socksProxyPort": { type: "port", scope: "any" },
  "network.tlsTerminate": { type: "object", scope: "user" },
  "credentials": { type: "object" },
  "credentials.files": { type: "objects", scope: "any", list: true },
  "credentials.envVars": { type: "objects", scope: "any", list: true },
  "credentials.allowPlaintextInject": { type: "boolean", scope: "user" },
  "credentials.awsPairs": { type: "objects", scope: "user", list: true },
  "credentials.sigv4": { type: "any", scope: "user" },
};

/** The keys whose entries are lists that Claude Code joins across files (docs: "merges them, combining the paths"). */
export const LIST_KEYS = Object.entries(SANDBOX_KEYS).filter(([, v]) => v.list).map(([k]) => k);

/** The sub-objects that only group keys. */
export const GROUPS = ["filesystem", "network", "credentials"];

/** The keys that are plain values: the highest file that sets one wins. (ignoreViolations is merged as one value.) */
export const SCALAR_KEYS = Object.entries(SANDBOX_KEYS).filter(([k, v]) => !v.list && !GROUPS.includes(k) && k !== "ignoreViolations").map(([k]) => k);

/** The sandbox keys a repository (project and local settings) cannot use to loosen an admin-required sandbox (docs). */
export const LOOSENING_LISTS = [
  "excludedCommands", "ignoreViolations", "network.allowedDomains", "network.allowUnixSockets", "network.allowMachLookup",
  "network.httpProxyPort", "network.socksProxyPort", "filesystem.allowWrite",
];
/** A `true` from a repository is ignored under an admin-required sandbox; a `false` still applies (docs). */
export const LOOSENING_FLAGS = ["enableWeakerNestedSandbox", "enableWeakerNetworkIsolation", "network.allowAllUnixSockets", "network.allowLocalBinding"];

/** The platform names Claude Code uses in `enabledPlatforms` (schema). */
export const PLATFORMS = ["macos", "linux", "wsl", "windows"];

/**
 * Commands that stay sandboxed whatever `excludedCommands` says, so an entry for one of them never matches. Read from the
 * code of Claude Code 2.1.299 and put to the binary in CI (test/why-table.mjs has a row for each); the docs name sudo, eval,
 * xargs, cd, pushd and popd.
 */
export const STAYS_SANDBOXED = {
  // a command that runs another command, or runs code it is given
  runs: new Set(["eval", "source", ".", "exec", "nocorrect", "fc", "coproc", "trap", "enable", "mapfile", "readarray", "hash", "bind", "complete", "compgen", "alias", "let"]),
  wrappers: new Set(["builtin", "command", "xargs", "sed", "sudo", "doas", "su", "runuser", "pkexec", "chroot", "noglob", "nocorrect", "busybox", "toybox"]),
  awk: new Set(["awk", "gawk", "mawk", "nawk"]),
  watchers: new Set(["watch", "ionice", "chrt", "setsid", "taskset", "strace", "ltrace", "script", "flock", "unshare", "nsenter"]),
  // builtins that set variables or shell options
  variables: new Set(["declare", "typeset", "local", "export", "readonly", "print", "getopts", "set", "zparseopts", "zformat", "zstyle", "autoload", "shift", "vared", "private", "getln", "zregexparse", "float", "integer", "read"]),
  zsh: new Set(["zmodload", "emulate", "sysopen", "sysread", "syswrite", "sysseek", "zpty", "ztcp", "zsocket", "zf_rm", "zf_mv", "zf_ln", "zf_chmod", "zf_chown", "zf_mkdir", "zf_rmdir", "zf_chgrp", "repeat", "foreach", "zcompile", "setopt", "unsetopt", "disable", "shopt", "autoload", "functions"]),
  directory: new Set(["cd", "chdir", "pushd", "popd"]),
};

/** Wrappers that Claude Code looks through before it matches an entry (the `timeout 30 docker ps` form). */
export const LOOKED_THROUGH = ["timeout", "time", "nice", "stdbuf", "nohup"];

/** Flags that stop Claude Code from taking a call with that program out of the sandbox (read from the code, then put to the binary). */
export const RISKY_FLAGS = {
  printf: ["-v"], jobs: ["-x"],
  kubectl: ["--kubeconfig", "-s", "--server", "--insecure-skip-tls-verify"],
  docker: ["-H", "--host", "--config", "--context"],
  aws: ["--profile", "--endpoint-url"],
  git: ["--extcmd", "--config-env", "--exec-path", "--upload-pack", "--output", "--unsafe-paths", "--directory", "--separate-git-dir", "--open-files-in-pager", "--httpd", "--receive-pack", "--access-hook"],
};

/** Programs that read a script from their own arguments or their input: a call with one stays sandboxed when it has a flag that runs code. */
export const INTERPRETERS = {
  sh: ["-c"], bash: ["-c", "--init-file", "--rcfile"], zsh: ["-c"], dash: ["-c"], ksh: ["-c"], ash: ["-c"], csh: ["-c"], tcsh: ["-c"], mksh: ["-c"],
  fish: ["-c", "--command", "-C", "--init-command"], python: ["-c"], perl: ["-e", "-E", "-M", "-m", "-d"], ruby: ["-e", "-r", "--require"],
  php: ["-r", "-R", "-B", "-E", "-F", "-d", "-c"], lua: ["-e", "-l"], deno: ["--eval", "--eval-file"],
  node: ["--env-file", "--env-file-if-exists", "--test-reporter", "--run", "-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--experimental-loader"],
  bun: ["-e", "--eval", "-p", "--print", "-r", "--preload", "--require", "--import", "-c", "--config"],
};

/** The git forms that take a path: a clone, an init, a worktree add or move, a bundle create with an absolute, ~ or .. path stays sandboxed (docs). */
export const GIT_PATH_FORMS = ["clone", "init", "worktree add", "worktree move", "bundle create"];

/** Environment variables whose assignment in front of a command Claude Code steps over (the same list the permission rules use). */
export { SAFE_ENV } from "./engine/wrappers.mjs";

/** The size of a call the sandbox check looks at (characters). */
export const MAX_CALL_CHARS = 10000;
