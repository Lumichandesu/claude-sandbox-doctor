# Contributing to claude-sandbox-doctor

Thanks for helping. claude-sandbox-doctor is a CLI and a Claude Code plugin with one user-only skill, part of the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit). The bar for a change is the bar the code already meets: it works on Windows, macOS and Linux, it is tested, and it never wastes anyone's tokens.

## Start here

- **Good first issues:** [the issues labelled good first issue](https://github.com/nrzz/claude-sandbox-doctor/issues?q=is%3Aopen+label%3A%22good+first+issue%22), and the ideas in [ROADMAP.md](ROADMAP.md).
- **Questions and ideas:** [Discussions](https://github.com/nrzz/claude-sandbox-doctor/discussions).
- **Bugs:** [open an issue](https://github.com/nrzz/claude-sandbox-doctor/issues/new/choose) with the Claude Code version (`claude --version`), your OS (and for Linux the distribution and `bwrap --version`), `node --version`, and the exact command and output. For a wrong answer from `why` or a wrong finding from `lint`, add the few lines of settings that cause it and what Claude Code did (where the command ran, or what `claude doctor` says); that pair is the test case.

## Set up

There is nothing to install: the project has no dependencies.

```bash
git clone https://github.com/nrzz/claude-sandbox-doctor
cd claude-sandbox-doctor
npm test
```

- `node bin/claude-sandbox-doctor.mjs lint --project examples/shop` lints a project, `why "docker ps" --project examples/shop` explains a call, `check` looks at this machine.
- `E2E_CLAUDE=claude node --test test/e2e-*.test.mjs` also puts the tool's claims about Claude Code to the real binary (see below). The bash sandbox exists on Linux, WSL2 and macOS only; on Windows the checks that need it skip.
- Point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at a temporary folder whenever you run the tool, the tests or `claude` by hand; the tests do it for themselves. The Claude folder and `~/.claude.json` are the files Claude Code keeps rewriting; never test against yours.

## Where things are

| Path | What it holds |
| --- | --- |
| `bin/claude-sandbox-doctor.mjs` | the CLI entry |
| `src/cli.mjs`, `src/commands.mjs` | the options, the help, the exit codes; the four commands as plain objects |
| `src/settings.mjs`, `src/sandbox.mjs`, `src/facts.mjs` | reading every settings file with the line of each key; the merge; the tables of keys and scopes |
| `src/exclusion.mjs`, `src/why.mjs` | matching a call against `excludedCommands` and the reasons it stays inside; the decision and the approval |
| `src/lint.mjs` | the rules, each in `RULES` with its severity, its basis (`binary` or `docs`) and what it finds |
| `src/host.mjs`, `src/live.mjs` | the only code that starts a program; the second also opens the listener of `--live` and writes its throwaway folder |
| `src/render.mjs` | the text, markdown and JSON reports; the hiding of credentials |
| `src/engine/` | the command reader and rule matcher, copied from claude-permission-doctor (each file says from which commit) |
| `skills/check/`, `.claude-plugin/` | the user-only skill; the plugin manifest and icon |
| `examples/` | the two projects the README's examples are run on |
| `test/*.test.mjs` | unit tests; `e2e-*.test.mjs` run against the real binary when `E2E_CLAUDE` is set |
| `test/why-table.mjs`, `test/domain-table.mjs` | the calls and the domain entries that `why` and `lint` are held to, and that CI puts to the binary |
| `test/oracle.mjs`, `test/claude-sandbox.mjs`, `test/managed.mjs` | running the binary at zero tokens; the managed-settings file a CI runner may write |
| `test/fake-claude.mjs`, `test/fakesys.mjs` | a stand-in for the binary and a machine that is not the one the tests run on |

## House rules

1. **No dependencies.** Node built-ins only, Node 18 or newer, ES modules (`.mjs`). A pull request that adds a package to `dependencies` will not be merged. Only `src/host.mjs` and `src/live.mjs` may start a process, only `src/live.mjs` may open a connection or write a file; a test fails otherwise.
2. **Every change comes with a test**, and `npm test` passes. CI runs the suite on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18, and the real-binary checks on Linux (with and without bubblewrap) and macOS; a change that only works on one of them is not done.
3. **The binary is right.** The answers of `why` and the findings of `lint` say what Claude Code does because the real binary was put to it. When one is wrong, add the case to a table (`test/why-table.mjs` for a call, `test/domain-table.mjs` for a domain entry, `test/e2e-keys.test.mjs` for a key) with what Claude Code did, run it with `E2E_CLAUDE`, fix the code, and say so in the README's "What was verified, and how". Do not change an expectation to make a test pass without running it against the binary. A rule whose claim comes from the documentation only has basis `docs` in `RULES`; it becomes `binary` when a test shows the binary doing it.
4. **Token cost is a feature.** The tool runs outside Claude; the one skill is user-only and its report is capped. If your change puts anything new in front of Claude, say how many tokens in the pull request and update the README's "What it costs in tokens".
5. **The tool changes none of the user's files.** It reads settings files and writes nothing; `--live` creates a throwaway folder in the temporary directory and removes it. Keep it so.
6. **Never touch real user data in tests.** Use a temporary folder and point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at it, in the same command, whenever you run the tool, `claude` or anything else that reads them. `test/helpers.mjs` points every way the tool finds a config folder at a throwaway one the moment it loads. The managed-settings checks write the system folder only on a CI runner (`test/managed.mjs` refuses anywhere else).
7. **Nothing secret in the output.** The text and markdown reports go through `hideSecrets` in `src/render.mjs`. A new report needs a test that a secret in an entry is not in it.
8. **Keep the README honest.** Its "What was verified, and how" section says what was checked and what was not. If your change affects either, update it in the same pull request. `test/readme.test.mjs` holds the usage block, the numbers, the tables of rules and reasons, the JSON shapes and the examples to the code.

## The real-binary checks

The `test/e2e-*.test.mjs` files start a fake Messages API on 127.0.0.1 and run the real Claude Code binary against it, with a throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR`, a project folder that Claude Code already trusts, and stand-in programs that record whether `SANDBOX_RUNTIME` was set, which tells inside from outside. No model is reached and nothing leaves your machine. The binary is started asynchronously with its standard input ignored (a synchronous start blocks the fake server, and `-p` waits for input on an open stdin).

```bash
E2E_CLAUDE=/path/to/claude node --test test/e2e-table.test.mjs       # the table of calls, the approvals (needs bubblewrap and socat on Linux)
E2E_CLAUDE=/path/to/claude node --test test/e2e-domains.test.mjs     # the domain entries
E2E_CLAUDE=/path/to/claude node --test test/e2e-plugin.test.mjs      # the plugin and the skill; runs on Windows too
```

On Ubuntu 24.04 bubblewrap needs the AppArmor profile that Claude Code's documentation gives (the e2e workflow writes it). `test/e2e-managed.test.mjs` writes `managed-settings.json` with `sudo` and runs only on a GitHub Actions runner with `CSD_E2E_MANAGED=1`; do not try it on your machine. The workflow takes a `claude_version` input, so a release can be put to the same tables by hand.

## Pull requests

- One logical change per pull request, with its test. Commit messages in the imperative mood ("Warn about a loopback domain").
- Fill in the pull request template; CI must be green on every job.
- Signed commits are welcome but not required.
- Plain, specific writing in docs, messages and comments.

## Releases (maintainers)

Bump the version in `src/version.mjs`, `package.json` and `.claude-plugin/plugin.json` (`npm test` fails until every copy agrees), add a section to [CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish a GitHub release with the changelog section as its notes.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
