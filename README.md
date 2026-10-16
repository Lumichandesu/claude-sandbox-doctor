# claude-sandbox-doctor

[![test](https://github.com/nrzz/claude-sandbox-doctor/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-sandbox-doctor/actions/workflows/test.yml) [![e2e](https://github.com/nrzz/claude-sandbox-doctor/actions/workflows/e2e.yml/badge.svg)](https://github.com/nrzz/claude-sandbox-doctor/actions/workflows/e2e.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

Claude Code's Bash sandbox is a steady source of issues. On 16 October 2026, anthropics/claude-code had 202 open issues with "sandbox" in the title and 276 under area:sandbox. The same shapes come back. On some Linux machines every Bash call fails with `bwrap: execvp /bin/bash: No such file or directory` ([#99680](https://github.com/anthropics/claude-code/issues/99680), reported on a merged-usr distribution). The seccomp helper fails with `write /proc/self/setgroups: Permission denied` ([#43454](https://github.com/anthropics/claude-code/issues/43454), 54 reactions). A command that should run outside the sandbox does not: a redirection on a single excluded command defeats `excludedCommands` ([#95532](https://github.com/anthropics/claude-code/issues/95532)), and the rule that every part of a compound command must match an entry also drops single commands that carry a flag before the subcommand, such as `git -C` ([#95455](https://github.com/anthropics/claude-code/issues/95455)). A request to let sandboxed commands connect to localhost has 80 reactions ([#28018](https://github.com/anthropics/claude-code/issues/28018)). From outside a session it is hard to tell whether a given command runs inside the sandbox, outside it or not at all, and why, and a setting that can never take effect gives no warning.

claude-sandbox-doctor checks whether the Bash sandbox can start on this machine (bubblewrap and socat on Linux and WSL2, Seatbelt on macOS, the merged-usr layout, user namespaces), and with `--live` runs the real Claude Code against a fake API on your machine, at zero tokens, to see a command inside the sandbox, a write outside the project blocked and a connection to a host that is not allowed refused. It shows the merged `sandbox` settings with the file and line of every value, says for any Bash command whether Claude Code runs it inside the sandbox, outside it or not at all, and which `excludedCommands` entry matched each part or why none did, and finds sandbox settings that can never take effect. It is a plain Node program that runs outside Claude, so it costs no tokens, and what it says about Claude Code is what the real binary did when the same cases were put to it in CI.

## What you get

- `check`: whether the sandbox can start here, without running Claude Code. On Linux and WSL2 it finds `bwrap` and `socat`, reads the user-namespace limits (including Ubuntu's AppArmor restriction), starts a shell in a bubblewrap sandbox with the flags Claude Code uses, answers the merged-usr question of #99680 (does `/bin/bash` run inside the mounts?), tries the `/proc/self/setgroups` write of #43454 and notes a container. On macOS it runs `sandbox-exec` with a trial profile. On Windows and WSL1 it says there is no Bash sandbox and exits 0. With `--live` it also runs the real binary in a throwaway config with a fake API on 127.0.0.1 and `sandbox.enabled: true`, asks for a command, a write outside the project and a connection to a host that is not allowed, and says whether each was blocked by the sandbox, ran outside it or was refused.
- `show`: the merged `sandbox` settings of managed, local, project and user files, every value with the file and line it came from, which file wins, what it shadows, what Claude Code leaves out (a key the file may not set, the entries an admin-required sandbox ignores in a repository), and the permission settings that reach the sandbox.
- `why "<command>"`: whether Claude Code runs the call inside the sandbox, outside it, or refuses the retry. For each part of the call it names the `excludedCommands` entry that matched, or why none could: a redirection, a command substitution, a `cd`, a part that is `sudo`, `eval`, `xargs` or a shell given `-c`, a flag such as `git -C`, a variable in front, a wrapper Claude Code does not read. It also says whether `autoAllowBashIfSandboxed` approves the call without a prompt. `--retry` asks the other question: what happens when the model sets `dangerouslyDisableSandbox` after a failure.
- `lint` finds sandbox settings that can never take effect: an `excludedCommands` entry that can never take a call out of the sandbox, a domain with a scheme, a path or a bad port, `failIfUnavailable` on a machine that cannot start the sandbox, a settings file Claude Code drops whole, a key the wrong file sets (`bwrapPath`, `socatPath` and `enabledPlatforms` outside managed settings), keys that do something on another system only, `allowedDomains` while the permission mode is `bypassPermissions` (Claude Code then lets every host through), an `allowWrite` entry for a path the sandbox keeps write-protected, `autoAllowBashIfSandboxed` with no sandbox, and `enableWeakerNestedSandbox`. Each finding has the file and the line, what Claude Code does about it, and a fix. The rules table says which findings the real binary confirmed and which come from the documentation.
- `--json` on every command, for scripts and for other tools.
- `/sandbox-doctor:check`, a plugin skill that hands Claude the short form of the `lint` report and of `check` (`--markdown`).

## What it costs in tokens

| Part | Tokens | |
| --- | --- | --- |
| The tool: every command, `--json`, `--markdown` | 0 | It reads settings files and starts bubblewrap, socat, `unshare` or `sandbox-exec` with trial arguments. `check --live` starts Claude Code against a fake server on 127.0.0.1, so no request reaches Anthropic and no model is used. |
| The skill in the model's request | 0 | `/sandbox-doctor:check` is user-only (`disable-model-invocation: true`) and its description is `Check the sandbox.`: 18 characters, about 5 tokens by characters / 4. With the plugin loaded, the request for a plain prompt had the same size as without it, the same tool list and no occurrence of `sandbox-doctor`: 69,652 characters on 2.1.299 and 69,122 on 2.1.295 on Windows, 64,688 on Linux and 65,667 on macOS against 2.1.301 in CI. `claude plugin details` projects `Always-on: ~10 tok` for the skill, and the capture does not bear that out. |
| `/sandbox-doctor:check` | about 390 to 445 tokens once; about 1,100 to 1,155 at the cap | The model receives the lint report, the check of the machine and a 209-character instruction that asks for a reply of at most 10 lines. For a project with 3 findings, with the paths of a temporary folder, that was 1,554 characters on Windows (1,447 in the skill block and 107 in the command block), 1,777 on Linux (1,670 and 107) and 1,744 on macOS (1,637 and 107): 389, 444 and 436 tokens. The lint report holds at most 12 findings and at most 300 characters to a line. A report at the cap (30 excluded commands with long names and 30 domains with a scheme and a path) was 4,391 characters on Windows (4,284 and 107), 4,614 on Linux (4,507 and 107) and 4,581 on macOS (4,474 and 107): 1,098, 1,154 and 1,145 tokens. These are characters divided by 4, an estimate, not a count by Claude's tokenizer. The same findings in a terminal cost nothing: `claude-sandbox-doctor lint`. |

## Install

**From a terminal**, with Node 18 or newer. There is nothing to install and no dependency:

```bash
npx -y github:nrzz/claude-sandbox-doctor check
```

```bash
npx -y github:nrzz/claude-sandbox-doctor lint --project .
```

Or from a clone:

```bash
git clone https://github.com/nrzz/claude-sandbox-doctor
node claude-sandbox-doctor/bin/claude-sandbox-doctor.mjs check
```

**As a Claude Code plugin**, in Claude Code:

```text
/plugin marketplace add nrzz/claude-code-toolkit
/plugin install sandbox-doctor@claude-code-toolkit
```

Then type `/sandbox-doctor:check`. It runs `lint --markdown` for the current project and `check --markdown` for the machine, and asks Claude to answer in at most 10 lines: whether the sandbox can work here, and each setting that can never take effect with its file and the fix. It also asks Claude to edit nothing until you agree. To try the plugin from a clone before it is in the marketplace: `claude --plugin-dir ./claude-sandbox-doctor`.

## Use

```text
Usage: claude-sandbox-doctor <command> [options]

Read (they change nothing):
  check    [--live] [--claude <path>] [--markdown]
           whether the Bash sandbox can start on this machine, without running Claude Code: the system;
           on Linux and WSL2 bubblewrap and socat, user namespaces (and the AppArmor limit on them), the
           merged-usr layout (/bin/bash inside the mounts), a nested user namespace, a container; on
           macOS sandbox-exec. On Windows and WSL1 it says there is no Bash sandbox and exits 0.
           --live also runs the real Claude Code (the one on PATH, or --claude) in a throwaway config
           against a fake API on 127.0.0.1, at zero tokens, with the sandbox on, and asks for a command
           inside the sandbox, a write outside the project and a connection to a host that is not
           allowed; it says whether each was blocked, ran outside, or was refused. Exit 1 when the
           sandbox cannot start, or a probe was not blocked. --markdown is the short form the
           /sandbox-doctor:check skill hands to Claude; it always exits 0
  show     [--project <dir>]
           the merged sandbox settings (managed, local, project, user): every value with the file and
           line it came from, which file wins, what it shadows, the entries Claude Code leaves out (a key
           that only user or managed settings may set; what an admin-required sandbox ignores in a
           repository's files), and the permission settings that reach the sandbox
  why      "<command>" [--retry] [--project <dir>]
           whether Claude Code runs the Bash call inside the sandbox, outside it (which excludedCommands
           entry matched each part, or why no entry did: the whole call has a redirection, a command
           substitution or a cd; a part is sudo, eval, xargs, a shell given -c, git given -C, a variable
           in front, a wrapper it does not read ...), and whether autoAllowBashIfSandboxed approves it
           without a prompt. --retry asks the other question: the model sets dangerouslyDisableSandbox
           after a failure; Claude Code honors it, or refuses it (allowUnsandboxedCommands is false).
           Exit 1 when the answer is "refused" or a deny rule refuses the call
  lint     [--project <dir>] [--markdown]
           sandbox settings that can never take effect: excludedCommands entries that never match, an
           allowedDomains entry with a scheme, a path or a bad port, failIfUnavailable on a machine that
           cannot start the sandbox, settings inert on this system, keys the wrong file sets,
           bwrapPath and socatPath outside managed settings, autoAllowBashIfSandboxed with the sandbox
           off, allowWrite entries for protected paths, enableWeakerNestedSandbox. Exit 1 on an error or
           a warning. --markdown is the short form for the skill; it always exits 0

Files: --project <dir> is the folder Claude Code starts in (the current folder when you leave it out);
its settings are <dir>/.claude/settings.json and settings.local.json. The user settings are in the
config folder (CLAUDE_CONFIG_DIR, else ~/.claude), and managed settings in /etc/claude-code on Linux and
WSL2, /Library/Application Support/ClaudeCode on macOS, C:\Program Files\ClaudeCode on Windows.

Options for every command:
  --json         one JSON document on stdout
  --no-color     no colour on a terminal (NO_COLOR does the same)
  -h, --help     this text
  -v, --version  the version

Exit codes: 0 ok; 1 findings, a refusal, or a sandbox that cannot work; 2 a usage error or an unexpected error.
Environment: CLAUDE_CONFIG_DIR (Claude's config folder), NO_COLOR, and
CLAUDE_SANDBOX_DOCTOR_MANAGED_DIR (the folder to read managed-settings.json from, instead of the
system folder; the tests use it).
It reads settings files and writes nothing. It starts programs only in check (bubblewrap, socat, unshare
and sandbox-exec, with a few harmless trial arguments) and, with --live, Claude Code itself; the only
connection it opens is --live's listener on 127.0.0.1, and it sends nothing anywhere.
```

`--project` is the folder Claude Code starts in; leave it out for the current folder. `--no-color` (or `NO_COLOR`) turns colour off on a terminal. Every command takes `--json`: one JSON document on stdout, also for a usage error (`{ "ok": false, "error": "..." }`, exit 2). The examples below were run on ubuntu-latest in CI (run 38957876417, Claude Code 2.1.301), on the projects in `examples/` copied to the home folder of the runner (`~/shop` and `~/locked`), with no user settings. Run them on your machine with `--project examples/shop`: you will see your own user settings merged in.

### `check`

Whether the Bash sandbox can start on this machine. It does not run Claude Code (`--live` does), so it costs nothing. On Ubuntu 24.04 in CI, with `bubblewrap` and `socat` installed from apt and the AppArmor profile of the Claude Code documentation for `bwrap` in place:

```text
$ claude-sandbox-doctor check
claude-sandbox-doctor 1.0.0  can the Bash sandbox work here
system    Linux, Ubuntu 24.04.5 LTS  (kernel 6.17.0-1022-azure)

  ok    bubblewrap 0.9.0 at /usr/bin/bwrap
  ok    socat version 1.8.0.0 at /usr/bin/socat
  ok    bubblewrap starts a shell with a user, process and network namespace and the host mounted
        read-only
          kernel.unprivileged_userns_clone=1, user.max_user_namespaces=63795,
          kernel.apparmor_restrict_unprivileged_userns=1; the trial is bwrap --new-session
          --die-with-parent --unshare-net --ro-bind / / --dev /dev --unshare-pid --unshare-user
          --cap-drop ALL --proc /proc -- /bin/bash -c echo sandbox-doctor-ok
  ok    /bin is a link to usr/bin (merged-usr), and /bin/bash runs inside the sandbox's mounts
          Claude Code mounts / as a whole, so the links survive; a sandbox that mounted only /usr
          would fail with "execvp /bin/bash: No such file or directory"
          (anthropics/claude-code#99680).
  info  unshare -U cannot write /proc/self/setgroups here: sh: 1: cannot create
        /proc/self/setgroups: Permission denied
          This is the command of anthropics/claude-code#43454 (54 reactions on 16 October 2026),
          where Claude Code's apply-seccomp helper fails with "write /proc/self/setgroups:
          Permission denied". Here bubblewrap starts anyway, so the command does not by itself stop
          the sandbox: --live shows what Claude Code does.

The sandbox can start on this machine.
Not tried: a real Claude Code run (check --live does that, at zero tokens), the proxy that checks the allowed domains, the seccomp helper.
```

The line with `#43454` is information, not a failure: the command that fails in that issue fails on this runner too, and Claude Code still runs commands inside the sandbox here (see `--live` below). The `merged-usr` line answers #99680. Exit code 1 when a dependency is missing, bubblewrap cannot start or (with `--live`) a probe was not blocked; 0 otherwise, also on Windows and WSL1, where there is no Bash sandbox to check.

`--live` runs the real Claude Code, at zero tokens, and asks it for three commands. The same machine:

```text
$ claude-sandbox-doctor check --live
claude-sandbox-doctor 1.0.0  can the Bash sandbox work here
system    Linux, Ubuntu 24.04.5 LTS  (kernel 6.17.0-1022-azure)

  ok    bubblewrap 0.9.0 at /usr/bin/bwrap
  ok    socat version 1.8.0.0 at /usr/bin/socat
  ok    bubblewrap starts a shell with a user, process and network namespace and the host mounted
        read-only
          kernel.unprivileged_userns_clone=1, user.max_user_namespaces=63795,
          kernel.apparmor_restrict_unprivileged_userns=1; the trial is bwrap --new-session
          --die-with-parent --unshare-net --ro-bind / / --dev /dev --unshare-pid --unshare-user
          --cap-drop ALL --proc /proc -- /bin/bash -c echo sandbox-doctor-ok
  ok    /bin is a link to usr/bin (merged-usr), and /bin/bash runs inside the sandbox's mounts
          Claude Code mounts / as a whole, so the links survive; a sandbox that mounted only /usr
          would fail with "execvp /bin/bash: No such file or directory"
          (anthropics/claude-code#99680).
  info  unshare -U cannot write /proc/self/setgroups here: sh: 1: cannot create
        /proc/self/setgroups: Permission denied
          This is the command of anthropics/claude-code#43454 (54 reactions on 16 October 2026),
          where Claude Code's apply-seccomp helper fails with "write /proc/self/setgroups:
          Permission denied". Here bubblewrap starts anyway, so the command does not by itself stop
          the sandbox: --live shows what Claude Code does.

The sandbox can start on this machine.

Claude Code, put to the test (--live)
  claude    2.1.301 (Claude Code)
  inside    a command runs inside the sandbox
            SANDBOX_RUNTIME=1: the command ran inside the sandbox
  blocked   a write outside the project
            the write failed: Read-only file system
  blocked   a connection to a host that is not allowed
            the sandbox's proxy refused it and named sandbox-doctor-probe.invalid:80
The sandbox kept the command inside, refused the write and refused the connection.
```

On macOS, in CI (the first part, `check` alone, is only the `sandbox-exec` line):

```text
$ claude-sandbox-doctor check --live
claude-sandbox-doctor 1.0.0  can the Bash sandbox work here
system    macOS 26.6.2  (arm64)

  ok    Seatbelt works: sandbox-exec ran a command under a profile (/usr/bin/sandbox-exec)

Seatbelt is there. The sandbox can start on this Mac.

Claude Code, put to the test (--live)
  claude    2.1.301 (Claude Code)
  inside    a command runs inside the sandbox
            SANDBOX_RUNTIME=1: the command ran inside the sandbox
  blocked   a write outside the project
            the write failed: Operation not permitted
  blocked   a connection to a host that is not allowed
            the sandbox's proxy refused it and named sandbox-doctor-probe.invalid:80
The sandbox kept the command inside, refused the write and refused the connection.
```

On a Linux machine that has neither `bubblewrap` nor `socat` (the CI job that removes them):

```text
$ claude-sandbox-doctor check
claude-sandbox-doctor 1.0.0  can the Bash sandbox work here
system    Linux, Ubuntu 24.04.5 LTS  (kernel 6.17.0-1022-azure)

  FAIL  bubblewrap (bwrap) is not installed
          fix: Install it: `sudo apt-get install bubblewrap socat` (Debian, Ubuntu), `sudo dnf
          install bubblewrap socat` (Fedora).
  FAIL  socat is not installed
          fix: Install it: `sudo apt-get install socat` (Debian, Ubuntu), `sudo dnf install socat`
          (Fedora).
  skip  user namespaces: kernel.unprivileged_userns_clone=1, user.max_user_namespaces=63838,
        kernel.apparmor_restrict_unprivileged_userns=1
          not tried: bubblewrap is missing

Missing: bwrap, socat. The sandbox cannot start until they are installed. With sandbox.enabled on, Claude Code then runs commands without it and prints "Sandbox disabled", or refuses to start when sandbox.failIfUnavailable is true.
```

`--live` is not run there: with the dependencies missing there is nothing to put to the binary that `check` has not said. `--claude <path>` names the Claude Code to run when it is not the `claude` on the PATH. `--markdown` prints the short form that the plugin's skill hands to Claude (the heading, at most seven lines, the summary):

```text
$ claude-sandbox-doctor check --markdown
## sandbox-doctor check: Linux, Ubuntu 24.04.5 LTS
- OK bubblewrap 0.9.0 at /usr/bin/bwrap
- OK socat version 1.8.0.0 at /usr/bin/socat
- OK bubblewrap starts a shell with a user, process and network namespace and the host mounted read-only
- OK /bin is a link to usr/bin (merged-usr), and /bin/bash runs inside the sandbox's mounts
The sandbox can start on this machine.
```

### `show`

The merged `sandbox` settings, with the file and line of every value. `~/shop` is `examples/shop`: a project with a bare `docker` entry, three entries that never take a call out of the sandbox, domains with a scheme and a path, an `allowWrite` entry for `.mcp.json` and a `bwrapPath` that only managed settings may set.

```text
$ claude-sandbox-doctor show --project ~/shop
claude-sandbox-doctor 1.0.0  the sandbox settings Claude Code merges
project   /home/runner/shop
config    /home/runner/.claude
system    Linux, Ubuntu 24.04.5 LTS

Settings files, highest precedence first
  managed  /etc/claude-code/managed-settings.json  not found
  local    .claude/settings.local.json             not found
  project  .claude/settings.json                   read, 7 sandbox keys
  user     ~/.claude/settings.json                 not found

What the keys add up to
  sandbox on          yes
  retry outside       allowed: Claude may retry a failed command with dangerouslyDisableSandbox
  auto-allow          on: a sandboxed command runs without a prompt
  failIfUnavailable   off: where the sandbox cannot start, commands run without it and a warning says so
  admin-required      no
  read block          off

Merged sandbox settings
  enabled                              true                               project .claude/settings.json:3
  bwrapPath                            (ignored)
      ignored: "/opt/bwrap/bin/bwrap" in project .claude/settings.json:18: only managed settings set this key
  excludedCommands                     6 entries
      "docker"                                     project .claude/settings.json:5
      "docker compose *"                           project .claude/settings.json:6
      "git push *"                                 project .claude/settings.json:7
      "sudo systemctl *"                           project .claude/settings.json:8
      "cd infra && terraform *"                    project .claude/settings.json:9
      "npm run build > build.log"                  project .claude/settings.json:10
  network.allowedDomains               4 entries
      "github.com"                                 project .claude/settings.json:13
      "https://registry.npmjs.org"                 project .claude/settings.json:13
      "api.example.com/v1"                         project .claude/settings.json:13
      "*.npmjs.org"                                project .claude/settings.json:13
  filesystem.allowWrite                2 entries
      "~/.cache/*"                                 project .claude/settings.json:16
      ".mcp.json"                                  project .claude/settings.json:16

Not read by this tool:
  - server-managed settings, macOS profiles and the Windows registry (only managed-settings.json and
    managed-settings.d are read)
  - the --settings and --setting-sources flags, which a launcher can add (a --settings that forbids
    the retry makes the sandbox admin-required too)
  - hooks and mods, which can decide a call before the sandbox does
```

A value that no file may set (`bwrapPath` in a project file) is listed as ignored, with the file and line. A list entry that an admin-required sandbox leaves out of a repository's file is listed the same way, with the reason.

### `why`

Whether Claude Code runs a Bash call inside the sandbox or outside it, and which `excludedCommands` entry matched each part of the call, or why none did. The entry `docker compose *` takes `docker compose up -d` out of the sandbox:

```text
$ claude-sandbox-doctor why "docker compose up -d" --project ~/shop
claude-sandbox-doctor 1.0.0  where a Bash call runs
project   /home/runner/shop
call      docker compose up -d

Runs      outside the sandbox
          every part of the call is covered by an excludedCommands entry
          docker compose up -d                     matches "docker compose *"  project .claude/settings.json:6

excludedCommands that apply
  "docker"                                project .claude/settings.json:5
  "docker compose *"                      project .claude/settings.json:6
  "git push *"                            project .claude/settings.json:7
  "sudo systemctl *"                      project .claude/settings.json:8
  "cd infra && terraform *"               project .claude/settings.json:9
  "npm run build > build.log"             project .claude/settings.json:10

Approval  it runs outside the sandbox, so it goes through the regular permission flow: your allow rules and the permission mode decide whether you see a prompt (a read-only command such as ls passes)

Note: A PreToolUse hook, or a mod, can decide a call before any of this; hooks are not read. The
      model, not you, decides whether to retry with dangerouslyDisableSandbox.
```

The entry `docker`, without a wildcard, matches only the bare command, so `docker ps` stays inside (and `lint` calls the entry a `bare-entry`):

```text
$ claude-sandbox-doctor why "docker ps" --project ~/shop
claude-sandbox-doctor 1.0.0  where a Bash call runs
project   /home/runner/shop
call      docker ps

Runs      inside the sandbox
          no excludedCommands entry takes the whole call out of the sandbox
          docker ps: no entry of excludedCommands matches this part

excludedCommands that apply
  "docker"                                project .claude/settings.json:5
  "docker compose *"                      project .claude/settings.json:6
  "git push *"                            project .claude/settings.json:7
  "sudo systemctl *"                      project .claude/settings.json:8
  "cd infra && terraform *"               project .claude/settings.json:9
  "npm run build > build.log"             project .claude/settings.json:10

Approval  approved without a prompt: it runs inside the sandbox and autoAllowBashIfSandboxed is on
If Claude retries with dangerouslyDisableSandbox: it runs outside the sandbox
          (allowUnsandboxedCommands is not false); you are asked, or your allow rules decide. Ask with
          --retry.

Note: A PreToolUse hook, or a mod, can decide a call before any of this; hooks are not read. The
      model, not you, decides whether to retry with dangerouslyDisableSandbox.
```

A `cd` in the call keeps the whole call inside, even where the other part has an entry:

```text
$ claude-sandbox-doctor why "cd infra && terraform plan" --project ~/shop
claude-sandbox-doctor 1.0.0  where a Bash call runs
project   /home/runner/shop
call      cd infra && terraform plan

Runs      inside the sandbox
          no excludedCommands entry takes the whole call out of the sandbox
          cd infra: cd, chdir, pushd and popd are never excluded, wherever they are in the call
          terraform plan: no entry of excludedCommands matches this part

excludedCommands that apply
  "docker"                                project .claude/settings.json:5
  "docker compose *"                      project .claude/settings.json:6
  "git push *"                            project .claude/settings.json:7
  "sudo systemctl *"                      project .claude/settings.json:8
  "cd infra && terraform *"               project .claude/settings.json:9
  "npm run build > build.log"             project .claude/settings.json:10

Approval  approved without a prompt: it runs inside the sandbox and autoAllowBashIfSandboxed is on
If Claude retries with dangerouslyDisableSandbox: it runs outside the sandbox
          (allowUnsandboxedCommands is not false); you are asked, or your allow rules decide. Ask with
          --retry.

Note: A PreToolUse hook, or a mod, can decide a call before any of this; hooks are not read. The
      model, not you, decides whether to retry with dangerouslyDisableSandbox.
```

So does a redirection to a file (the entry `npm run build > build.log` can never match, because the call has the redirection in it; this is #95532):

```text
$ claude-sandbox-doctor why "npm run build > build.log" --project ~/shop
claude-sandbox-doctor 1.0.0  where a Bash call runs
project   /home/runner/shop
call      npm run build > build.log

Runs      inside the sandbox
          no excludedCommands entry takes the whole call out of the sandbox
          the whole call: a redirection to or from a file or a here-document (only one that copies a
          file descriptor, such as 2>&1, is allowed): Claude Code keeps the whole call sandboxed
          npm run build: no entry of excludedCommands matches this part

excludedCommands that apply
  "docker"                                project .claude/settings.json:5
  "docker compose *"                      project .claude/settings.json:6
  "git push *"                            project .claude/settings.json:7
  "sudo systemctl *"                      project .claude/settings.json:8
  "cd infra && terraform *"               project .claude/settings.json:9
  "npm run build > build.log"             project .claude/settings.json:10

Approval  approved without a prompt: it runs inside the sandbox and autoAllowBashIfSandboxed is on
If Claude retries with dangerouslyDisableSandbox: it runs outside the sandbox
          (allowUnsandboxedCommands is not false); you are asked, or your allow rules decide. Ask with
          --retry.

Note: A PreToolUse hook, or a mod, can decide a call before any of this; hooks are not read. The
      model, not you, decides whether to retry with dangerouslyDisableSandbox.
```

`--retry` asks what happens when the model repeats a call that failed with `dangerouslyDisableSandbox: true`. In `~/shop` Claude Code honors it (a prompt, or your allow rules, decide whether the call may run):

```text
$ claude-sandbox-doctor why "npm test" --project ~/shop --retry
claude-sandbox-doctor 1.0.0  where a Bash call runs
project   /home/runner/shop
call      npm test   (as a retry with dangerouslyDisableSandbox: true)

Runs      outside the sandbox
          allowUnsandboxedCommands is not false, so Claude Code honors dangerouslyDisableSandbox:
          true (a prompt, or your rules, decide whether it may run)

excludedCommands that apply
  "docker"                                project .claude/settings.json:5
  "docker compose *"                      project .claude/settings.json:6
  "git push *"                            project .claude/settings.json:7
  "sudo systemctl *"                      project .claude/settings.json:8
  "cd infra && terraform *"               project .claude/settings.json:9
  "npm run build > build.log"             project .claude/settings.json:10

Approval  it runs outside the sandbox, so it goes through the regular permission flow: your allow rules and the permission mode decide whether you see a prompt (a read-only command such as ls passes)

Note: A PreToolUse hook, or a mod, can decide a call before any of this; hooks are not read. The
      model, not you, decides whether to retry with dangerouslyDisableSandbox.
```

In `~/locked`, which has `allowUnsandboxedCommands: false`, the retry is refused and the call stays inside the sandbox. `why` exits 1 for that answer, and also when a deny rule refuses the call:

```text
$ claude-sandbox-doctor why "npm test" --project ~/locked --retry
claude-sandbox-doctor 1.0.0  where a Bash call runs
project   /home/runner/locked
call      npm test   (as a retry with dangerouslyDisableSandbox: true)

Runs      refused
          allowUnsandboxedCommands is false (.claude/settings.json:4), so Claude Code ignores
          dangerouslyDisableSandbox: the call runs inside the sandbox anyway
          npm test: no entry of excludedCommands matches this part

excludedCommands that apply
  "gh *"                                  project .claude/settings.json:5

Approval  approved without a prompt: it runs inside the sandbox and autoAllowBashIfSandboxed is on

Note: A PreToolUse hook, or a mod, can decide a call before any of this; hooks are not read. The
      model, not you, decides whether to retry with dangerouslyDisableSandbox.
```

An excluded command in `~/locked` still leaves the sandbox, because `excludedCommands` does not need the retry:

```text
$ claude-sandbox-doctor why "gh pr list" --project ~/locked
claude-sandbox-doctor 1.0.0  where a Bash call runs
project   /home/runner/locked
call      gh pr list

Runs      outside the sandbox
          every part of the call is covered by an excludedCommands entry
          gh pr list                               matches "gh *"  project .claude/settings.json:5

excludedCommands that apply
  "gh *"                                  project .claude/settings.json:5

Approval  it runs outside the sandbox, so it goes through the regular permission flow: your allow rules and the permission mode decide whether you see a prompt (a read-only command such as ls passes)

Note: A PreToolUse hook, or a mod, can decide a call before any of this; hooks are not read. The
      model, not you, decides whether to retry with dangerouslyDisableSandbox.
```

The answer is for the system the tool runs on: on Windows and WSL1 every command runs outside a sandbox, and `why` says what the answer would be on Linux, WSL2 and macOS. What it cannot know is said in the notes: a `PreToolUse` hook or a mod can decide a call before any of this, and the model, not you, decides whether to retry.

### `lint`

Sandbox settings that can never take effect, each with the file and line, what Claude Code does about it, and a fix. The same project:

```text
$ claude-sandbox-doctor lint --project ~/shop
claude-sandbox-doctor 1.0.0  lint
project   /home/runner/shop
system    Linux, Ubuntu 24.04.5 LTS

.claude/settings.json  project settings
  warning bare-entry             line 5  sandbox.excludedCommands
      excludedCommands entry "docker" has no wildcard, so it matches only the bare command "docker"
      with no arguments (docs: "docker matches only docker with no arguments").
      fix: Write "docker *" to match the command with or without arguments.
  warning dead-entry             line 8  sandbox.excludedCommands
      excludedCommands entry "sudo systemctl *" can never take a call out of the sandbox: a command
      that runs another command (sudo, doas, su, xargs, sed, command, builtin, ...) is never
      excluded (tried "sudo systemctl x").
      fix: Claude Code never takes these out of the sandbox. Use filesystem.allowWrite or
      network.allowedDomains to give the command what it needs, or exclude the program it runs.
  warning dead-entry             line 9  sandbox.excludedCommands
      excludedCommands entry "cd infra && terraform *" can never take a call out of the sandbox: cd,
      chdir, pushd and popd are never excluded, wherever they are in the call (tried "cd infra &&
      terraform x").
      fix: cd, pushd and popd are never excluded. Run the command in its own call (Claude Code keeps
      the working folder from one call to the next).
  warning dead-entry             line 10  sandbox.excludedCommands
      excludedCommands entry "npm run build > build.log" can never take a call out of the sandbox: a
      redirection to or from a file or a here-document (only one that copies a file descriptor, such
      as 2>&1, is allowed): Claude Code keeps the whole call sandboxed.
      fix: An entry cannot contain a redirection: Claude Code keeps a call with a redirection to a
      file sandboxed, whatever the entries say.
  warning domain-scheme          line 13  network.allowedDomains
      "https://registry.npmjs.org" has a scheme (https://), so it is compared with the host name as
      a whole and never equals one.
      fix: Write the host only: "registry.npmjs.org".
  warning domain-path            line 13  network.allowedDomains
      "api.example.com/v1" has a path, a query or a user name in it, but the sandbox's proxy
      compares host names (and a port), so it never matches.
      fix: Write the host only: "api.example.com".
  warning write-glob-linux       line 16  filesystem.allowWrite
      "~/.cache/*" has a wildcard. On Linux and WSL2 the sandbox mounts concrete paths, so Claude
      Code skips an allowWrite entry with *, ? or [ and it has no effect there (it works on macOS).
      fix: Write the folder, without the wildcard.
  warning protected-path         line 16  filesystem.allowWrite
      ".mcp.json" names .mcp.json, which the sandbox keeps write-protected: an allowWrite entry does
      not lift that protection.
      fix: Take the entry out; the only way to write there is filesystem.disabled, which turns off
      filesystem isolation for every path.
  warning key-scope              line 18  sandbox.bwrapPath
      sandbox.bwrapPath is honored only from managed settings. Claude Code ignores it in project
      settings.
      fix: Set it in managed settings, or remove it.
  note    wildcard-apex          line 13  network.allowedDomains
      "*.npmjs.org" matches the subdomains of npmjs.org only, not npmjs.org itself.
      fix: List npmjs.org too if you need it.

0 errors, 9 warnings, 1 note (1 settings file read)
```

Exit code 1 for an error or a warning, 0 for notes only. The rules are in the table under How it works. `--markdown` is the short form for the skill: the heading, at most 12 findings of at most 300 characters, never exit code 1 (a skill whose command line exits 1 never reaches the model). Here the first nine lines:

```text
$ claude-sandbox-doctor lint --project ~/shop --markdown
## sandbox-doctor lint: /home/runner/shop
1 settings file read, 0 errors, 9 warnings, 1 note. System: Linux, Ubuntu 24.04.5 LTS.
- WARNING `bare-entry` .claude/settings.json:5 `sandbox.excludedCommands`: excludedCommands entry "docker" has no wildcard, so it matches only the bare command "docker" with no arguments (docs: "docker matches only docker with no arguments"). Fix: Write "docker *" to match the command with or wit...
- WARNING `dead-entry` .claude/settings.json:8 `sandbox.excludedCommands`: excludedCommands entry "sudo systemctl *" can never take a call out of the sandbox: a command that runs another command (sudo, doas, su, xargs, sed, command, builtin, ...) is never excluded (tried "sudo systemctl x"). Fix:...
- WARNING `dead-entry` .claude/settings.json:9 `sandbox.excludedCommands`: excludedCommands entry "cd infra && terraform *" can never take a call out of the sandbox: cd, chdir, pushd and popd are never excluded, wherever they are in the call (tried "cd infra && terraform x"). Fix: cd, pushd and p...
- WARNING `dead-entry` .claude/settings.json:10 `sandbox.excludedCommands`: excludedCommands entry "npm run build > build.log" can never take a call out of the sandbox: a redirection to or from a file or a here-document (only one that copies a file descriptor, such as 2>&1, is allowed): Claude Co...
- WARNING `domain-scheme` .claude/settings.json:13 `network.allowedDomains`: "https://registry.npmjs.org" has a scheme (https://), so it is compared with the host name as a whole and never equals one. Fix: Write the host only: "registry.npmjs.org".
- WARNING `domain-path` .claude/settings.json:13 `network.allowedDomains`: "api.example.com/v1" has a path, a query or a user name in it, but the sandbox's proxy compares host names (and a port), so it never matches. Fix: Write the host only: "api.example.com".
- WARNING `write-glob-linux` .claude/settings.json:16 `filesystem.allowWrite`: "~/.cache/*" has a wildcard. On Linux and WSL2 the sandbox mounts concrete paths, so Claude Code skips an allowWrite entry with *, ? or [ and it has no effect there (it works on macOS). Fix: Write the folder, without t...
- WARNING `protected-path` .claude/settings.json:16 `filesystem.allowWrite`: ".mcp.json" names .mcp.json, which the sandbox keeps write-protected: an allowWrite entry does not lift that protection. Fix: Take the entry out; the only way to write there is filesystem.disabled, which turns off filesy...
- WARNING `key-scope` .claude/settings.json:18 `sandbox.bwrapPath`: sandbox.bwrapPath is honored only from managed settings. Claude Code ignores it in project settings. Fix: Set it in managed settings, or remove it.
```

### The JSON documents

The shapes below name the fields that are always there and mark the ones that are not with `?`. Paths in a document are the paths of the system it ran on. `show` and `why` name the file and line of a value with the same `source` object, `{ scope, label, display, path, rank, line }`.

```text
check   { ok, platform: { id, label, claude, hasSandbox, detail }, hasSandbox,
          items: [ { id, status, title, detail?, fix?, issue? } ], missing: [ ], summary,
          live: null | { skipped, reason?, claude?, version?, ok?, exit?, stderr?, warnings?, startError?,
                         probes?: [ { id, title, command, outcome, evidence, decision, text } ] } }
show    { ok, project, configDir, configSource,
          platform: { id, label, claude, hasSandbox, detail }, present,
          files: [ { scope, label, display, path, rank, exists, ignored?, sandboxKeys? } ],
          values: { <key>: { key, winner?: { value, source: { scope, label, display, path, rank, line }, ignored? },
                             set: [ { value, source: { scope, label, display, path, rank, line }, ignored? } ], shadowed: [ ] } },
          lists: { <key>: [ { value, sources: [ { scope, label, display, path, rank, line } ], ignored: [ ] } ] },
          effective: { platform, claudePlatform, enabledInSettings, platformListed, enabled, failIfUnavailable,
                       autoAllowBashIfSandboxed, allowUnsandboxedCommands, strictBy: [ ], adminRequired, adminReasons: [ ],
                       excludedCommands: [ { value, sources: [ ] } ], ignoredExcluded: [ ], blockReads: { on, sources: [ ] } },
          notes: [ ], derived: { allowWrite: [ ], denyWrite: [ ], denyRead: [ ], allowedDomains: [ ], deniedDomains: [ ], additionalDirectories: [ ] },
          notRead: [ ] }
why     { ok, command, retry, platform, sandbox: { on, enabledInSettings, platformListed, failIfUnavailable, adminRequired },
          entries: [ { entry, source: { scope, label, display, path, rank, line } } ], ignoredEntries: [ ],
          callReasons: [ { code, text } ],
          parts: [ { text, covered, trivially, matched?: { entry, candidate, source: { scope, label, display, path, rank, line } },
                     reasons: [ { code, text } ], normalized } ],
          excludedBy: [ { part, entry, source: { scope, label, display, path, rank, line } } ],
          verdict, basis, runs, strict, strictBy: [ ],
          approval: { how, outcome, text, shapes: [ { code, text } ], denyRule, askRule, allowRule },
          notes: [ ], reason, project, configDir, system: { id, label, claude, hasSandbox, detail } }
lint    { ok, project, configDir, platform: { id, label, claude, hasSandbox, detail }, hostMissing: [ ],
          findings: [ { effect, basis, id, severity, scope, file, display, line, keyPath, message, fix, reason? } ],
          counts: { error, warning, note },
          files: [ { scope, label, path, display, exists, ignored, sandboxKeys } ] }
```

- `status` of a `check` item is `ok`, `fail`, `warn`, `info` or `skip`. `outcome` of a probe is `inside`, `outside`, `blocked`, `refused`, `error` or `unknown`.
- `verdict` of `why` is `sandboxed`, `unsandboxed` or `refused`, and `runs` says where the call runs: `sandboxed` or `unsandboxed`. `basis` is `sandbox-off`, `excluded`, `retry-allowed`, `retry-refused`, `shape`, `no-match` or `no-entries`. `approval.how` is `denied`, `ask`, `auto-allow`, `allow-rule` or `regular`, and `approval.outcome` is `approved`, `asked` or `denied`.
- `severity` of a lint finding is `error`, `warning` or `note`; `effect` says what the finding changes (`file`, `key`, `entry`, `start` or `none`); `basis` is `binary` or `docs`.

## How it works

It reads, on your machine only, the places below. Where a statement is about what Claude Code does, "What was verified, and how" says whether the real binary was asked.

- **Settings files**, highest precedence first: `managed-settings.json` and the files in `managed-settings.d/` in the system folder (`/etc/claude-code` on Linux and WSL2, `/Library/Application Support/ClaudeCode` on macOS, `C:\Program Files\ClaudeCode` on Windows; the documentation applies the drop-in files on top of the base file, and so does the tool), then `<project>/.claude/settings.local.json`, `<project>/.claude/settings.json`, and the user file in `$CLAUDE_CONFIG_DIR` (else `~/.claude`). `--project` names the folder Claude Code starts in; without it, the current folder. A scalar key (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, ...) takes the value of the highest file that sets it. The list keys (`excludedCommands`, `filesystem.allowWrite`, `network.allowedDomains`, ...) are joined across the files. A file that is not strict JSON (a comment or a trailing comma is enough) or that has a value of the wrong type in its `sandbox` block is ignored whole by Claude Code, and so by this tool, which says so. Not read: server-managed settings, macOS profiles, the Windows registry, and the `--settings` and `--setting-sources` flags that a launcher can add.
- **The machine**, for `check`: `bwrap` and `socat` on the PATH (or at `sandbox.bwrapPath` and `socatPath` from managed settings), the sysctls `kernel.unprivileged_userns_clone`, `user.max_user_namespaces` and `kernel.apparmor_restrict_unprivileged_userns`, whether `/bin` is a link into `/usr`, the files a container leaves, `unshare`, and `/usr/bin/sandbox-exec` on macOS. It starts only `bwrap`, `socat -V`, `unshare` and `sandbox-exec`, each with a few harmless arguments, and changes nothing.
- **Claude Code itself**, only for `check --live`: the `claude` on the PATH, or the one named by `--claude`, in a throwaway folder (see below).

### How `why` decides

Claude Code runs a Bash call outside the sandbox in three cases, and `why` checks them in this order. Everything else runs inside.

1. **The sandbox is off.** `sandbox.enabled` is not true in any file that applies, or managed `enabledPlatforms` leaves this system out. Then nothing is sandboxed, and `autoAllowBashIfSandboxed` approves nothing.
2. **Every part of the call is excluded.** `excludedCommands` entries are written like Bash permission rules: an exact command (`git status`), a prefix (`npm run:*`) or a wildcard (`docker *`). A compound call is split into its parts (`&&`, `||`, `;`, `|`) and every part must be covered by an entry. Many shapes keep the whole call inside the sandbox whatever the entries say, and many keep a single part from matching. The table below lists the reasons `why` gives for them.
3. **The model retried.** After a failure the model may repeat the call with `dangerouslyDisableSandbox: true`. Claude Code honors it unless `allowUnsandboxedCommands` is false. A `false` in user or managed settings holds against a project's `true`, and managed `allowUnsandboxedCommands: false` also makes the sandbox admin-required (below). `why --retry` asks about this case; without it `why` says what a retry would do. A call that is excluded needs no retry.

An **admin-required** sandbox ignores the repository's entries. It is one where managed settings set `allowUnsandboxedCommands: false` or `network.allowManagedDomainsOnly: true`: then `excludedCommands`, `network.allowedDomains` and the other keys that loosen the sandbox in project and local files do not count, and `show` and `lint` say which entries were left out.

Whether the call needs a prompt is a separate question, and `why` answers it too. A sandboxed call is approved without one when `autoAllowBashIfSandboxed` is on (the default), unless a deny or ask rule names it, it has a variable assigned in front or an argument of the form `NAME=value` (`make CC=clang`), it uses `eval` or a redirection from or to `/dev/tcp`; a read-only command such as `docker ps` passes either way. A call that runs outside the sandbox goes through the regular flow: your allow rules and the permission mode decide.

#### Why a call stays inside the sandbox in spite of an entry

| Reason | What it means |
| --- | --- |
| `too-long` | the call is longer than 10,000 characters, which Claude Code does not take apart |
| `unusual-text` | the call has a control character, a lone surrogate, a backslash before a line break, `~[`, `=word` or `<1-5>`, which Claude Code does not read as plain shell |
| `unparseable` | Claude Code cannot read the call as shell |
| `substitution` | a command substitution ($( ), backticks, ${ ; }) or an arithmetic expansion: Claude Code keeps the whole call sandboxed |
| `process-substitution` | a process substitution <( ) or >( ): Claude Code keeps the whole call sandboxed |
| `subshell` | a subshell ( ): Claude Code keeps the whole call sandboxed |
| `group` | a group in braces or double parentheses: Claude Code keeps the whole call sandboxed |
| `control-flow` | an if, for, while, until or select block: Claude Code keeps the whole call sandboxed |
| `function` | a function definition or coproc: Claude Code keeps the whole call sandboxed |
| `case` | a case statement: Claude Code keeps the whole call sandboxed |
| `test-brackets` | a test in [ ] or [[ ]]: Claude Code keeps the whole call sandboxed |
| `redirect` | a redirection to or from a file or a here-document (only one that copies a file descriptor, such as 2>&1, is allowed): Claude Code keeps the whole call sandboxed |
| `variable-flow` | a variable is set in one part of the call and used in another |
| `quote-trick` | a $"..." string or a brace expansion with a quote in it |
| `empty` | there is nothing to match |
| `directory` | cd, chdir, pushd and popd are never excluded, wherever they are in the call |
| `wrapper` | a command that runs another command (sudo, doas, su, xargs, sed, command, builtin, ...) is never excluded |
| `runs-code` | a builtin that runs or defines code (eval, source, exec, trap, alias, ...) is never excluded |
| `awk` | awk can run commands, so it is never excluded |
| `watcher` | watch, strace, flock, unshare and the like run another program and are never excluded |
| `shell-state` | a builtin that sets variables or shell options (export, declare, set, shift, read, ...) is never excluded |
| `zsh-builtin` | a zsh builtin that can run code or change the shell is never excluded |
| `unsafe-assignment` | a variable is assigned in front of the command, and only a short list of harmless ones (NODE_ENV, LANG, CI, ...) is looked through |
| `command-word` | the command word has a variable, quote, backslash, glob or backtick in it |
| `leading-dash` | the part starts with a dash |
| `env` | env is looked through only as plain `env`, `/bin/env` or `/usr/bin/env`, with at most -i, -0 and -u NAME |
| `ifs` | the part uses $IFS |
| `unusual-space` | the call has a space character that is not a plain space or tab |
| `unlooked-wrapper` | a wrapper such as timeout, nice or stdbuf has arguments Claude Code does not read |
| `interpreter` | a shell or interpreter given a flag that runs code (-c, -e, --eval, ...), or reading its program from input |
| `risky-flag` | a flag that points the program somewhere else or runs code (docker -H, kubectl --server, aws --profile, ...) |
| `git-flag` | git given -c, -C, --git-dir, --work-tree, --exec-path or another flag that changes where it runs or what it runs |
| `git-path` | git clone, init, worktree add or move, bundle create with a path that is absolute, starts with ~ or $, or has a .. segment |
| `git-run` | git bisect run, submodule foreach, hook run: they run another command |
| `git-config` | git config with a key that runs code (alias.*, core.sshCommand, core.pager, ...) |
| `pipe-stage` | make, at, ed, sqlite and crontab read their program from input, so after a pipe they are never excluded |
| `arg-expansion` | an argument of this program has a variable or substitution in it |
| `no-entry` | no entry of excludedCommands matches this part |

### What `check` tries

On Linux and WSL2 it starts `bwrap --new-session --die-with-parent --unshare-net --ro-bind / / --dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- /bin/bash -c "echo sandbox-doctor-ok"`, the flags that Claude Code 2.1.301 gives bubblewrap for a command (a test records the command line of a real run and holds this list to it; with `enableWeakerNestedSandbox` the real command line binds the host's `/proc` instead of mounting a fresh one, and so does the trial). If that fails it explains the error: the AppArmor limit on user namespaces on Ubuntu 24.04 and what to write in `/etc/apparmor.d`, a kernel without user namespaces, a missing `/bin/bash` (the message of #99680), or the setgroups denial of #43454. It also runs `unshare -U sh -c 'echo deny > /proc/self/setgroups'`, the command that fails in #43454. On a machine where `bwrap` starts, that command can still fail: on ubuntu-latest in CI it does, with "Permission denied", and Claude Code runs fine there, so `check` reports it as information and not as a failure. On macOS it runs `sandbox-exec` with a trial profile. On Windows and WSL1 it prints that there is no Bash sandbox and exits 0.

`check` does not try the proxy that checks the allowed domains or the seccomp helper. `check --live` does, through Claude Code.

### What `check --live` does

It starts the real `claude` with `-p`, a throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR`, a project folder inside it that Claude Code already trusts, and an environment with every `CLAUDE_*`, `ANTHROPIC_*` and `CLAUDECODE` variable of yours removed, updates and telemetry off. The model is a tiny server on 127.0.0.1 that answers with three Bash calls, one after the other: `printenv SANDBOX_RUNTIME` (Claude Code sets it to 1 for a command it runs in the sandbox), a `touch` of a file in the throwaway home (outside the project folder), and `curl` to `http://sandbox-doctor-probe.invalid/`. The settings are `sandbox.enabled: true` and an allow rule for the first call only, in the default permission mode, so a call that Claude Code would run without the sandbox, or ask about, shows up as such. For each call it reads the tool result and the permission decision from the stream and says whether the call was blocked by the sandbox, ran outside it, was refused, or could not start. No request reaches Anthropic and no token is spent. It uses the default permission mode because in `bypassPermissions` mode Claude Code lets every host through (below), which would make the third probe pass for the wrong reason.

### The network, and the permission mode

The sandbox's proxy checks each host of a sandboxed command against `network.allowedDomains`, which start empty. What happens to a host that is not on the list depends on the permission mode, as the documentation says, and the real binary did what it says. In `claude -p`, which cannot ask, the proxy refused the request (HTTP 403 and a line `deny network-outbound host:port` in the tool result) in the default, `acceptEdits` and `dontAsk` modes, and let it through in `bypassPermissions` mode. `permissions.defaultMode: "bypassPermissions"` in a user file did the same as the flag; in a project file it changed nothing, so the host was refused. A host in `deniedDomains` was refused in every mode. With `network.strictAllowlist: true` in a user file (or `allowManagedDomainsOnly` in managed settings) the proxy refused unlisted hosts in `bypassPermissions` mode too; `strictAllowlist` in a project file did nothing. `lint` therefore calls `allowedDomains` a setting that restricts nothing while the user's or managed settings put Claude Code in `bypassPermissions` mode (it cannot see the `--dangerously-skip-permissions` flag or `--permission-mode`). The domain table in the tests shows which spellings of an entry match a host: an exact name (case does not matter), `*.example.com` for subdomains at any depth but not for `example.com` itself, `*` for all, and `host:port` or `*.host:port` for one port. An entry with a scheme, a path or a user name, a star that is not the whole first label, a space, or a port that is not 1 to 65535 without a leading zero never matched anything.

### What `lint` finds

Each finding names the file and the line, says what Claude Code does about it, and gives a fix. "Basis" says where the claim comes from: **binary** means the real Claude Code was asked in CI and did what the finding says ("What was verified, and how" names the checks), **docs** means the documentation says so and the binary was not asked. Exit code 1 for an error or a warning, 0 for notes only.

| Finding | Severity | Basis | What it finds |
| --- | --- | --- | --- |
| `file-ignored` | error | binary | a settings file that Claude Code drops whole: a comment, a trailing comma, or a value of the wrong type in its sandbox block |
| `unknown-key` | warning | binary | a key the sandbox block does not have (a typo), which Claude Code ignores without a word |
| `key-scope` | warning | mixed | a key that only managed settings (or only user and managed settings) may set, in a file that may not (binary for bwrapPath, socatPath, enabledPlatforms, allowManagedDomainsOnly and strictAllowlist, docs for the other keys) |
| `relative-path` | warning | binary | a relative bwrapPath or socatPath in managed settings, which Claude Code drops |
| `platform-name` | warning | binary | an enabledPlatforms name that is none of macos, linux, wsl and windows |
| `protected-path` | warning | binary | an allowWrite entry for a path the sandbox keeps write-protected |
| `write-glob-linux` | warning | binary | a wildcard in an allowWrite or denyWrite entry on Linux and WSL2, where the sandbox mounts concrete paths |
| `domain-empty` | warning | binary | an empty allowedDomains or deniedDomains entry |
| `domain-space` | warning | binary | a domain entry with a space at its start or end |
| `domain-scheme` | warning | binary | a domain entry with a scheme (https://github.com) |
| `domain-path` | warning | binary | a domain entry with a path, a query or a user name in it |
| `domain-port` | warning | binary | a domain entry whose port is not 1 to 65535 without a leading zero |
| `domain-ipv6` | warning | binary | an IPv6 domain entry without brackets, which claude doctor calls unreliable |
| `domain-wildcard` | warning | binary | a domain entry with a * that is not the whole first label |
| `domain-chars` | warning | binary | a domain entry with characters a host name does not have |
| `wildcard-apex` | note | binary | *.example.com without example.com, which the wildcard does not match |
| `domains-bypass` | warning | binary | network.allowedDomains while permissions.defaultMode is bypassPermissions, a mode in which Claude Code lets every host through unless strictAllowlist or allowManagedDomainsOnly is on |
| `inert-here` | warning | docs | a key that does something only on another system (enableWeakerNetworkIsolation off macOS, bwrapPath off Linux) |
| `weaker-nested` | warning | binary | enableWeakerNestedSandbox, which mounts the host's /proc and says what that gives up |
| `mask-in-repository` | warning | docs | a credentials mask entry in a project or local file |
| `dead-entry` | warning | binary | an excludedCommands entry that can never take a call out of the sandbox |
| `bare-entry` | warning | binary | an excludedCommands entry with no wildcard, which matches the bare command only |
| `all-entry` | warning | binary | an excludedCommands entry that matches every command |
| `broad-entry` | note | docs | an excludedCommands entry for an interpreter, which lets a script leave the sandbox |
| `admin-required` | warning | binary | a repository's entry or key that an admin-required sandbox ignores |
| `auto-allow-without-sandbox` | warning | binary | autoAllowBashIfSandboxed with no sandbox, which approves nothing |
| `enabled-unset` | note | binary | sandbox keys with no sandbox.enabled anywhere |
| `retry-held` | note | binary | a project's allowUnsandboxedCommands true that a user or managed false holds back |
| `fail-if-unavailable` | error | binary | failIfUnavailable true on a machine where the sandbox cannot start |
| `no-sandbox-here` | note | binary | sandbox.enabled on a system with no Bash sandbox (Windows, WSL1) |
| `platform-excluded` | warning | binary | managed enabledPlatforms that leaves this system out |

Findings carry their own `basis` in `--json`. `key-scope` is `binary` for the keys the tests tried and `docs` for the others. A rule can only say what it says about the settings it can read: a hook or a mod can decide a call before the sandbox does, and neither is read.

### Privacy

It reads the settings files listed above and, for `check`, the system facts listed above, on your machine. It changes none of your files. The only thing it writes is the throwaway folder of `check --live` in the temporary directory, which it removes when the run ends, and a test fails if any file under `src/` or `bin/` but `src/live.mjs` calls a function that writes. It has no network code. The one connection it opens is the listener of `check --live` on 127.0.0.1, which only the `claude` it starts talks to; it sends nothing to Anthropic or to anyone else, has no telemetry and needs no account. It starts programs in `check` (`bwrap`, `socat`, `unshare`, `sandbox-exec`, with trial arguments) and, with `--live`, Claude Code; a test fails if any file but `src/host.mjs` and `src/live.mjs` imports `node:child_process`, or any file but `src/live.mjs` imports `node:http`. The text reports and the `--markdown` reports hide the value of a `NAME=value` whose name has KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL or AUTH in it, a Bearer or Basic value and the common token shapes, wherever a quoted entry holds one; the JSON documents are data and keep an entry as it is written. The plugin's skill runs `lint --markdown` and `check --markdown` and puts their reports in front of Claude when you invoke it. Those reports hold file paths, line numbers, the settings entries that have a finding (credentials hidden as above) and the facts of `check` (the versions of `bwrap` and `socat`, the kernel); they hold no environment value.

## What was verified, and how

Checked on 2026-10-16 and 2026-10-17 on Windows 11 with Node 24.19.0, git 2.55.0 and Claude Code 2.1.295 and 2.1.299 (every real-binary check that can run on Windows passed on both; the others need the sandbox, which Windows does not have). CI runs the unit tests on Linux, macOS and Windows with Node 20, 22 and 24 and on Linux with Node 18. It runs the real-binary checks on Linux (with bubblewrap and socat, and in a job that removes them) and on macOS, with Node 22, against the npm release of Claude Code (2.1.301 on 16 October 2026) and, started by hand with the workflow's version input, against 2.1.289, 2.1.292, 2.1.295, 2.1.299 and 2.1.302. On commit 9a5b80f all 10 jobs of the unit tests (run 38958398995) and all 3 jobs of the real-binary checks (run 38958399160) were green, and so were the 5 hand-started runs (38958408773, 38958416192, 38958423933, 38958432420 and 38958440346). The badges at the top show the latest runs. The CI image was ubuntu-latest (Ubuntu 24.04.5 LTS, kernel 6.17.0-1022-azure, bubblewrap 0.9.0, socat 1.8.0.0) and macos-latest (macOS 26.6.2, arm64).

- **218 automated tests** (`npm test`, Node's own runner, no dependencies, about 4 seconds). `node --test` also reports each of the 8 helper files under `test/` as a passing test, on every Node version CI runs (18 to 24); those are not counted here. Without a Claude Code binary 184 pass and 34 are skipped, on Windows, macOS and Linux alike: the skipped ones are the real-binary checks below, which run only when `E2E_CLAUDE` names a binary. The tests cover:
  - the settings reader (strict JSON, a comment, a trailing comma, a value of the wrong type, the line of each key, the unknown keys), the merge (the four files, the list keys, a key a file may not set, the admin-required rule, managed drop-ins) and the permission settings that reach the sandbox;
  - the matcher: `excludedCommands` against 221 calls, and a reason for each of the shapes in the table under How it works; the approval, with deny, ask and allow rules; the retry, with the three places `allowUnsandboxedCommands` can be false;
  - `check` on five machines that are not the one running the test (a healthy Ubuntu, an Ubuntu where AppArmor stops bubblewrap, an Ubuntu without `bwrap` and `socat`, a Mac, Windows), the explanation of each bubblewrap error, and `--live` against a stand-in for `claude` in six situations (healthy, outside, unavailable, broken, refuses to start, silent);
  - `lint`: a table of settings, each with the findings it must give and none other, the domain spellings (a table of 21 entries or sets of entries), that every rule is in `RULES` and every rule in `RULES` was given by some row;
  - the command line (every usage error, every exit code, the text, markdown and JSON reports, the hiding of credentials);
  - the package files, the skill, the workflows, the sources (which may start a program, open a connection or write), the engine files' provenance, the README: its sections, commands and flags, usage block, numbers, tables of rules and reasons, JSON shapes, examples and toolkit list; no carriage return in a tracked file.
- **34 checks against the real binary** (`test/e2e-*.test.mjs`, run when `E2E_CLAUDE` names a Claude Code binary). Each starts a fake Messages API on 127.0.0.1, so no model is reached and no token is spent. Each has its own throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR` and a project folder that Claude Code already trusts. The stand-in programs of a call (`docker`, `git`, `mytool`, ...) record whether `SANDBOX_RUNTIME` was set when they ran, which Claude Code sets for a command it runs in the sandbox, and so tell inside from outside whatever the call looks like. On Windows 11 the 13 checks that do not need the sandbox (the plugin and the skill, `claude doctor`, and the paths without a sandbox) passed against 2.1.295 and against 2.1.299; the other 21 skip there. In CI they ran on six versions of Claude Code.

  On every one of these versions, on Linux and on macOS, the four tables below agreed with the binary: 221 of 221 calls, 27 of 27 approval rows, 42 of 42 domain requests and 16 of 16 rows with managed settings. The other checks, run for each version (the 5 that macOS skips need bubblewrap):

  | Claude Code | Run | Linux with bubblewrap and socat | Linux without them | macOS |
  | --- | --- | --- | --- | --- |
  | 2.1.289 | 38958408773 | 31 of 31 checks pass | 3 of 3 checks pass | 26 of 31 checks pass, 5 skipped |
  | 2.1.292 | 38958416192 | 31 of 31 checks pass | 3 of 3 checks pass | 26 of 31 checks pass, 5 skipped |
  | 2.1.295 | 38958423933 | 31 of 31 checks pass | 3 of 3 checks pass | 26 of 31 checks pass, 5 skipped |
  | 2.1.299 | 38958432420 | 31 of 31 checks pass | 3 of 3 checks pass | 26 of 31 checks pass, 5 skipped |
  | 2.1.301 | 38958399160 | 31 of 31 checks pass | 3 of 3 checks pass | 26 of 31 checks pass, 5 skipped |
  | 2.1.302 | 38958440346 | 31 of 31 checks pass | 3 of 3 checks pass | 26 of 31 checks pass, 5 skipped |

  The findings below were the same on every version.

  - **Where a call runs.** The table of 221 calls (compounds, redirections, substitutions, wrappers, `excludedCommands` patterns, git forms and flags, interpreters, the retry with `allowUnsandboxedCommands` unset, true and false, the sandbox off, leading spaces, `*`) was run in groups of up to 24 calls, one `claude -p` session for each group. The binary ran every call where `why` says: inside the sandbox or outside it.
  - **Who approves the call.** 27 approval rows (the default permission mode, no allow rule for Bash): `autoAllowBashIfSandboxed` approved a sandboxed call, a read-only command passed either way, and the shapes `FOO=bar cmd`, `make CC=clang`, `eval` and a redirection from or to `/dev/tcp` went to the regular flow; deny, ask and allow rules, a bare `Bash` ask rule and the sandbox off behaved as `why` says.
  - **The network.** A request to a host that is not in `allowedDomains` was refused by the proxy in the default, `acceptEdits` and `dontAsk` modes and let through in `bypassPermissions` mode, also when a user file sets the mode and not when a project file does; a `deniedDomains` entry and (in a user file) `strictAllowlist` held in every mode. The table of 42 requests to hosts under `.invalid` showed which spellings of an entry match: a name (case-insensitive), `*.name` for subdomains at any depth and not for the name, `*`, `name:port` and `*.name:port`; and which never match anything (a scheme, a path, a user name, a star that is not the first label, a space, an empty entry, odd characters, a port of 0, above 65535 or with a leading zero).
  - **Keys that do nothing.** A settings file with a comment, with a trailing comma or with a value of the wrong type in its `sandbox` block was ignored whole (the sandbox it switched on stayed off, and `claude doctor` listed the wrong type under Invalid settings); a key that does not exist (`excludedCommand`) did nothing and `claude doctor` said nothing; `enabledPlatforms`, `network.allowManagedDomainsOnly`, `bwrapPath` and `socatPath` in a user file did nothing; `allowWrite` entries for `.mcp.json` and `.claude/settings.json` did not lift their protection; a wildcard in an `allowWrite` entry gave nothing on Linux (on macOS a new file whose name the wildcard matched could be written, and a file inside a folder it matched could not). `claude doctor` called an IPv6 domain without brackets unreliable and said nothing about the other spellings.
  - **Managed settings.** On a CI runner, with `managed-settings.json` written to `/etc/claude-code` or `/Library/Application Support/ClaudeCode` with `sudo` and removed again: 16 rows with managed settings (an admin-required sandbox ignored a repository's `excludedCommands`, `allowUnsandboxedCommands: true` and `allowedDomains`; managed entries counted; `enabledPlatforms` naming another system, or a name that is none, left the sandbox inert; a `false` in the user file held against a project's `true`) ran where `why` says; only the managed `allowedDomains` counted under `allowManagedDomainsOnly`; the managed `bwrapPath` was used and a relative one dropped; managed `defaultMode: bypassPermissions` let a host through; and `show`, `lint` and `why` read the same system folder.
  - **The bubblewrap command line.** With a stand-in for `bwrap` first on the PATH that records its arguments and runs the real one: the line starts `--new-session --die-with-parent --unshare-net`, mounts `/` read-only (`--ro-bind / /`), the project folder writable (`--bind` of the folder), and ends `--dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- /bin/bash -c ...`; about 22 paths (`.mcp.json`, `.bashrc`, `.gitconfig`, `.vscode`, the `.claude` entries that do not exist, ...) are bound to `/dev/null` to protect them. The trial of `check` has the same flags in the same order (a test holds the two to each other). With `enableWeakerNestedSandbox` the line has `--bind /proc /proc` and no `--proc /proc`.
  - **The merged-usr layout (#99680).** On ubuntu-latest `/bin` is a link to `usr/bin`; a mount of `/usr` alone failed with `bwrap: execvp /bin/bash: No such file or directory`, the mount with the links and the mount of `/` ran `/bin/bash`, and Claude Code (every version tried) ran its commands inside the sandbox there. `check` printed the `merged-usr` line as ok.
  - **Without bubblewrap and socat.** On Linux, with `sandbox.enabled` and `failIfUnavailable` unset, Claude Code printed `Sandbox disabled: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed, socat not installed` and "Commands will run WITHOUT sandboxing", and a call that an allow rule covers ran outside the sandbox (a call nothing covered was refused in `-p`, because nothing sandboxed it and the auto-allow did not apply). With `failIfUnavailable: true` it printed `Error: sandbox required but unavailable`, sent no request and exited 1. `check` listed the missing programs and exited 1, and `lint` called `failIfUnavailable` an error. On Windows (2.1.295 and 2.1.299) the same two texts named the feature gate (`the Windows sandbox is not active on this session (feature gate off)`), and `check` exits 0 there because there is no sandbox to check.
  - **`check --live`.** On Linux and macOS it found the command inside the sandbox, the write outside the project blocked (`Read-only file system` on Linux, `Operation not permitted` on macOS) and the connection refused with the host named, in the job that has the dependencies.
  - **The skill.** `claude plugin validate` and `--strict` pass. With the plugin loaded, a plain prompt's request was the same size as without it (69,652 characters on 2.1.299 and 69,122 on 2.1.295 on Windows, 64,688 on Linux and 65,667 on macOS against 2.1.301 in CI) and had the same tool list. `/sandbox-doctor:check` reached the model with the lint report for the project, the check of the machine and the instruction after them; a skill whose command line exits 1 never reached the model, which is why the markdown reports exit 0. The figures in "What it costs in tokens" are from that capture. The model could run the commands from the skill's `allowed-tools` with no prompt in the default permission mode, with the Bash tool and, on Windows, the PowerShell tool. `claude plugin details`: `Always-on: ~10 tok`, `check < 20` always-on and about 100 when used.
  - **The install line.** `npx -y github:nrzz/claude-sandbox-doctor#<commit> check --markdown`, with a throwaway home and npm cache, was run by the e2e job on Linux and on macOS (Node 22) against the commit it was testing. It printed the report on the third attempt in both jobs. The first two, made within a minute of the push, stopped with npm's `GitFetcher requires an Arborist constructor to pack a tarball`; I take that to mean that GitHub was not yet serving the tarball of the new commit, which was not checked. The step tries four times, 30 seconds apart. In a one-off experiment on a branch that was deleted afterwards, the same line, the line without a commit, and `npm exec` worked at once on Node 18, 20, 22 and 24, inside and outside a checkout of the repository, for commits that were a few minutes old.
- **The rules.** The table under How it works says, for each finding, whether the binary was asked (`binary`) or the documentation is the only source (`docs`). The `docs` rules are `inert-here`, `mask-in-repository` and `broad-entry`, and `key-scope` for the keys not named above.

## Not verified

- **WSL2.** Never run. The only WSL2 distribution on the machine where this was written is Docker Desktop's, which has no Node, and no CI runner is WSL2. `check` treats WSL2 like Linux and tells WSL1 from WSL2 by `/proc/version` and the kernel version, which no real WSL machine confirmed; the reporter of #99680 used Debian 13 on WSL2 with bubblewrap 0.12.0, and that setup was not reproduced.
- **#99680 itself.** Not reproduced. On ubuntu-latest (Ubuntu 24.04.5, merged-usr, bubblewrap 0.9.0) Claude Code 2.1.289 to 2.1.302 ran `/bin/bash` inside the sandbox, and a mount of `/usr` alone fails with the message of the issue. The report is about Claude Code 2.1.289 on Debian 13 with bubblewrap 0.12.0, so the cause may be the distribution, the bubblewrap version or WSL2. `check` runs the mounts Claude Code asks for on your machine and shows bubblewrap's own error if it fails.
- **Distributions other than the CI image.** One Linux image (Ubuntu 24.04.5, kernel 6.17.0-1022-azure) and one bubblewrap (0.9.0). Debian, Arch, Fedora, Alpine, NixOS and SELinux hosts were not tried. The AppArmor limit on user namespaces was met on that image and handled with the profile from Claude Code's documentation, which the e2e workflow writes.
- **macOS beyond one image.** macOS 26.6.2 on arm64 only. Intel Macs and older macOS were not tried, and the Seatbelt profile that Claude Code builds was not read.
- **Cowork's VM sandbox.** A different thing; not touched.
- **The desktop app's bundled Claude Code, and the IDE extensions.** Not driven. `check --live` runs the `claude` you give it (or the first on the PATH), which may not be the one your app uses.
- **Server-managed settings, macOS profiles and the Windows registry.** Not read, and not tried. The managed checks wrote a `managed-settings.json` in the system folder of a CI runner and removed it; that is the one managed source the tool reads. `managed-settings.d` (drop-in files) was read as the documentation describes it and was not put to the binary. The `--settings` and `--setting-sources` flags, which a launcher can add, cannot be seen from outside.
- **An interactive session.** Not driven: the `/sandbox` panel, the prompt that asks about a new domain (the documentation says it appears in the default and `acceptEdits` modes), and the prompt for an unsandboxed retry. Everything real-binary here uses `claude -p`. Whether a running session picks up a changed settings file without a restart was not checked.
- **Other permission modes.** The table of calls ran in `bypassPermissions` mode (so that every call runs and the place can be read from the stand-in programs), the approval table in the default mode, and the network checks in the default, `acceptEdits`, `dontAsk` and `bypassPermissions` modes. Auto mode and plan mode were not tried (auto mode needs a classifier answer that the fake API does not give), and approval was not tried in any mode but the default.
- **The seccomp helper.** `check` does not try it. Claude Code's `apply-seccomp` failing with `write /proc/self/setgroups: Permission denied` (#43454) was not reproduced: the same command fails on ubuntu-latest and Claude Code runs fine there. A machine where the helper fails was not available, so what `check` says about it is a pointer, not a diagnosis.
- **Settings tried by neither the table nor the checks.** Their lint rules and the lines of `show` are from the documentation: `allowAppleEvents`, `enableWeakerNetworkIsolation`, `allowLocalBinding`, `allowUnixSockets`, `allowMachLookup`, `ignoreViolations`, `ripgrep`, `filesystem.denyRead`, `allowRead`, `allowManagedReadPathsOnly` and `disabled`, `network.tlsTerminate`, `credentials`, and the SOCKS proxy. The rules table marks each rule `docs` or `binary`.
- **Containers.** `enableWeakerNestedSandbox` was run on a CI runner, which is not a container: only the change in bubblewrap's command line was recorded, not what the setting does inside Docker or Podman.
- **Windows beyond Claude Code 2.1.295 and 2.1.299.** There the sandbox is behind a feature gate that was off ("Sandbox disabled: ... the Windows sandbox is not active on this session (feature gate off)"). `check` says what that version did and exits 0; a later version that turns the gate on is not covered, and CI has no Windows job for the binary. The Windows runs were made by hand.
- **Other Claude Code versions.** Claude Code 2.1.289, 2.1.292, 2.1.295, 2.1.299, 2.1.301 and 2.1.302 were run on Linux and macOS, and 2.1.295 and 2.1.299 on Windows; no other release was. A release that changes how the sandbox decides shows up as a red job in the weekly e2e run.
- **Hooks and mods.** A `PreToolUse` hook, or a mod, can decide a call before the sandbox does. They are not read.
- **Token counts.** Every token figure is characters / 4, an estimate, and not a count by Claude's tokenizer.
- **The marketplace line.** `/plugin install sandbox-doctor@claude-code-toolkit` has not been tried: the toolkit's marketplace lists the plugin only after the hub is updated. The plugin installs and validates from a local marketplace folder.

## Files

| Path | What it is |
| --- | --- |
| `bin/claude-sandbox-doctor.mjs` | The command |
| `src/cli.mjs`, `src/commands.mjs` | The options, the help and the exit codes; the four commands as plain objects |
| `src/settings.mjs`, `src/sandbox.mjs`, `src/facts.mjs` | Reading every settings file with the line of each key; the merge, the admin-required rule and the permission settings that reach the sandbox; the tables of keys, scopes and shapes |
| `src/exclusion.mjs`, `src/why.mjs` | Matching a call against `excludedCommands` and naming the reason it stays inside; the decision (sandbox off, retry, excluded) and the approval |
| `src/lint.mjs` | The rules, each with its severity, its basis and what it finds |
| `src/host.mjs`, `src/live.mjs` | The only code that starts a program (`bwrap`, `socat`, `unshare`, `sandbox-exec`; `claude` and the fake API for `--live`); the second is also the only code that opens a connection and writes (its throwaway folder) |
| `src/render.mjs`, `src/jsonc.mjs`, `src/version.mjs` | The text, markdown and JSON reports and the hiding of credentials; reading JSON with comments to find their line; the version number, which `package.json` and `plugin.json` must agree with |
| `src/engine/shell.mjs`, `src/engine/wrappers.mjs`, `src/engine/pattern.mjs` | Claude Code's reading of a Bash call, the wrappers it looks through, the matching of a rule: copied from claude-permission-doctor by way of claude-automode-doctor; only the two comment lines at the top of each file are new |
| `src/engine/rule.mjs`, `src/engine/paths.mjs`, `src/engine/settings.mjs` | Permission rules, path rules and the settings loader, copied the same way |
| `skills/check/` | `/sandbox-doctor:check`, the user-only skill |
| `.claude-plugin/` | The plugin manifest and its icon |
| `examples/` | `shop`, a project with findings, and `locked`, a project whose retry is refused: the README's examples |
| `test/` | `npm test`. The helper files: `helpers.mjs` (the guard that points `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and the managed folder at a throwaway one), `why-table.mjs` and `domain-table.mjs` (the calls and the domain entries that `why` and the lint are held to), `oracle.mjs` and `claude-sandbox.mjs` (run the real binary), `managed.mjs` (writes managed settings on a CI runner), `fake-claude.mjs` and `fakesys.mjs` (stand in for the binary and for a machine). `e2e-*.test.mjs` put the claims to the binary, `readme.test.mjs` holds the README to the code |
| `.github/workflows/` | `test.yml` (the suite on three systems and four Node versions) and `e2e.yml` (the real binary on Linux with and without bubblewrap, and on macOS) |

Related: [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor) explains why a permission prompt appeared and finds dead rules (its command reader and rule matcher are in `src/engine/`), [claude-settings-doctor](https://github.com/nrzz/claude-settings-doctor) shows the merged settings and lints them against the schema, and [claude-automode-doctor](https://github.com/nrzz/claude-automode-doctor) says what auto mode decided.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-sandbox-doctor/issues?q=is%3Aopen+label%3A%22good+first+issue%22). For a wrong answer from `why` or a wrong finding from `lint`, send the few lines of settings that cause it, the command, and what Claude Code did (where it ran, or the `claude doctor` text); that becomes a row of a table. Questions go to [Discussions](https://github.com/nrzz/claude-sandbox-doctor/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay
- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them
- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history
- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep
- [claude-hook-bench](https://github.com/nrzz/claude-hook-bench): run every hook with the JSON Claude Code sends, and see what each one does
- [claude-relocate](https://github.com/nrzz/claude-relocate): move Claude Code's config folder to another drive or the XDG folders, safely, with undo
- [claude-settings-doctor](https://github.com/nrzz/claude-settings-doctor): a commented settings.jsonc that builds settings.json, the merged settings with their source, a lint against the schema
- [claude-automode-doctor](https://github.com/nrzz/claude-automode-doctor): what auto mode and its classifier decided, from your transcripts, plus a lint of the autoMode settings
- [claude-mcp-check](https://github.com/nrzz/claude-mcp-check): every MCP server Claude Code would load, from which file, whether it starts, and what its tools cost
- [claude-windows-doctor](https://github.com/nrzz/claude-windows-doctor): which shell the Bash tool gets on Windows and why, every claude on PATH, and the setup problems behind common Windows issues

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases.

## License

MIT
