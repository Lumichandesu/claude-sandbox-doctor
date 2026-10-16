# Security policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Use GitHub's private reporting: [https://github.com/nrzz/claude-sandbox-doctor/security/advisories/new](https://github.com/nrzz/claude-sandbox-doctor/security/advisories/new), or the contact in the [nrzz security policy](https://github.com/nrzz/.github/blob/main/SECURITY.md). You can expect a first answer within 72 hours, and credit in the release notes if you want it.

## What this tool does, and does not do

It reads the files that tell Claude Code how its Bash sandbox is set up: the managed settings in the system folder (`/etc/claude-code`, `/Library/Application Support/ClaudeCode`, `C:\Program Files\ClaudeCode`), the user settings in `$CLAUDE_CONFIG_DIR` or `~/.claude`, and the project's `.claude/settings.json` and `.claude/settings.local.json`. For `check` it also reads a few system facts (`/proc/version`, `/etc/os-release`, the user-namespace sysctls, whether `/bin` is a link). It has no telemetry or account and sends nothing to Anthropic or to anyone else.

**It starts programs in `check`, and the real Claude Code in `check --live`.** `check` runs `bwrap` (a trial sandbox that runs `/bin/bash -c "echo sandbox-doctor-ok"` with the host mounted read-only), `bwrap --version`, `socat -V`, `unshare -U sh -c "echo deny > /proc/self/setgroups"` (inside the new user namespace, so it changes nothing outside it) and, on macOS, `sandbox-exec` with a profile that allows everything and runs `/usr/bin/true`. `check --live` starts the `claude` that is first on the PATH, or the one named by `--claude`, with `-p`, a throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR`, the sandbox on, and a fake Messages API on 127.0.0.1 that asks it to run three commands: `printenv SANDBOX_RUNTIME`, a `touch` of a file in the throwaway home, and a `curl` to `http://sandbox-doctor-probe.invalid/` (a name that never resolves). No model is reached and no token is spent. The listener binds to 127.0.0.1 on a port the system picks and lives for the length of the run. **Run `--live` only with a `claude` you trust: it is started like any program.** Its environment is scrubbed of your `CLAUDE_*`, `ANTHROPIC_*` and `CLAUDECODE` variables, so it cannot use your login or your settings, and it is given a placeholder key.

It writes nothing of yours. The only thing it creates is the throwaway folder of `--live` in the temporary directory, which it removes when the run ends; a test fails if any file under `src/` or `bin/` but `src/live.mjs` calls a function that writes, or if any file but `src/host.mjs` and `src/live.mjs` starts a program.

The text and markdown reports hide the value of a `NAME=value` whose name contains KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL or AUTH, a Bearer or Basic value and the common token shapes wherever a quoted settings entry holds one. The JSON documents are data: they hold an entry as it is written in the file. Do not put a secret in a settings entry, and do not paste a JSON document where you would not paste the file.

The `why` and `lint` answers are a reading of what Claude Code did when it was put to the binary (the README's "What was verified, and how" says which versions); they are not a guard. A call that `why` says runs inside the sandbox is not thereby safe, and a settings file that lints clean can still allow more than you mean to. A wrong verdict is a bug and not a vulnerability: report it as an issue.
