// The table behind two tests:
//
//   test/why-table.test.mjs  no binary needed: what `why` says for each row must equal `expect` (and `code`, when a row has one);
//   test/e2e-table.test.mjs  with E2E_CLAUDE set, on Linux with bubblewrap and on macOS: what the real Claude Code does with the
//                            same row (the call is sent by a fake Messages API, and the programs of the call are stand-ins that
//                            record whether SANDBOX_RUNTIME was set) must equal `expect` too.
//
// A row is one Bash call under one set of settings files. `expect` is where Claude Code runs it:
//   "sandboxed"    inside the sandbox
//   "unsandboxed"  outside it (an excludedCommands entry covers every part of the call, or the retry was honored, or the sandbox is off)
// `code` is the first reason `why` gives for a call that stays sandboxed in spite of an entry (see REASONS in src/exclusion.mjs).
// `retry: true` makes the call carry dangerouslyDisableSandbox: true, as Claude does after the sandbox blocked something.
// {BIN} in a command is the folder of the stand-in programs (a command with a path in front).
// Every row was run against Claude Code in CI on Linux and macOS (README: What was verified, and how). A row with `linux` or
// `mac` is a place where the two systems differ.

export const PROGRAMS = ["docker", "dockerx", "gh", "git", "kubectl", "npm", "npx", "make", "terraform", "ssh", "curl", "aws", "python", "python3", "node", "ruby", "perl", "bash", "sh", "sudo", "mytool", "deno", "bun"];

export const FILES = {
  "a.txt": "hello\n",
  "in.txt": "in\n",
  "sub/b.txt": "b\n",
  "script.sh": "docker ps\n",
  "script.py": "print(1)\n",
  "app.js": "console.log(1)\n",
};

export const rows = [];
let count = 0;

function add(group, settings, command, expect, extra = {}) {
  rows.push({ id: `${group}-${String(++count).padStart(3, "0")}`, group, settings, command, expect, ...extra });
}
// list: [command, expect, code?, extra?]
const each = (group, settings, list) => { for (const [command, expect, code, extra] of list) add(group, settings, command, expect, { ...(code ? { code } : {}), ...(extra || {}) }); };

const S = (list, extra = {}) => ({ user: { sandbox: { enabled: true, excludedCommands: list, ...extra } } });
const U = "unsandboxed";
const B = "sandboxed";

// ---- entries, compounds, redirections, wrappers, shapes -----------------------------------------------------------------
const BASIC = S(["docker *", "git status", "kubectl:*", "gh *", "npm run *", "make", "terraform plan *", "ssh *", "python script.py", "echo *", "sudo *", "cd *", "eval *", "xargs *"]);

each("entry", BASIC, [
  ["docker ps", U],
  ["docker", U],
  ["docker compose up -d", U],
  ["git status", U],
  ["git status -s", B, "no-entry"],
  ["git log", B, "no-entry"],
  ["kubectl get pods", U],
  ["kubectl", U],
  ["gh pr list", U],
  ["npm run build", U],
  ["npm test", B, "no-entry"],
  ["npm run", U],
  ["make", U],
  ["make all", B, "no-entry"],
  ["terraform plan -out x", U],
  ["terraform apply", B, "no-entry"],
  ["ssh host", U],
  ["python script.py", U],
  ["python script.py extra", B, "no-entry"],
  ["mytool run", B, "no-entry"],
  ["{BIN}/docker ps", B, "no-entry"],
]);

each("compound", BASIC, [
  ["docker ps && docker images", U],
  ["docker ps; docker images", U],
  ["docker ps || docker images", U],
  ["docker ps && gh pr list", U],
  ["docker ps && npm test", B, "no-entry"],
  ["npm test && docker ps", B, "no-entry"],
  ["docker ps | mytool", B, "no-entry"],
  ["echo hi | docker ps", U],
  ["echo hi && docker ps", U],
  ["docker ps\ngh pr list", U],
  ["docker ps && docker images && docker volume ls", U],
  ["! docker ps", U],
  ["echo \"a && b\" && docker ps", U],
  ["docker ps # a comment", U],
  ["docker ps || mytool run", B, "no-entry"],
  ["git status && docker ps", U],
  ["git status && git log", B, "no-entry"],
]);

each("redirect", BASIC, [
  ["docker ps > out.txt", B, "redirect"],
  ["docker ps >> out.txt", B, "redirect"],
  ["docker ps 2>&1", U],
  ["docker ps 1>&2", U],
  ["docker ps >&2", U],
  ["docker ps 2>/dev/null", B, "redirect"],
  ["docker ps > /dev/null", B, "redirect"],
  ["docker ps &> out.txt", B, "redirect"],
  ["docker ps < in.txt", B, "redirect"],
  ["docker ps 2>&1 | echo x", U],
  ["docker ps <<< \"x\"", B, "redirect"],
  ["docker ps <<EOF\nx\nEOF", B, "redirect"],
  ["docker ps > out.txt && gh pr list", B, "redirect"],
  ["docker ps && gh pr list > out.txt", B, "redirect"],
  ["> out.txt docker ps", B, "redirect"],
  ["echo hi > out.txt && docker ps", B, "redirect"],
]);

each("wrapper", BASIC, [
  ["timeout 5 docker ps", U],
  ["timeout --foreground 5 docker ps", U],
  ["timeout -k 1 5 docker ps", U],
  ["time docker ps", U],
  ["nice docker ps", U],
  ["nice -n 5 docker ps", U],
  ["nohup docker ps", U],
  ["stdbuf -oL docker ps", U],
  ["env docker ps", U],
  ["env -u FOO docker ps", U],
  ["env FOO=bar docker ps", B, "unsafe-assignment"],
  ["NODE_ENV=test docker ps", U],
  ["CI=1 LANG=C docker ps", U],
  ["FOO=bar docker ps", B, "unsafe-assignment"],
  ["command docker ps", B, "wrapper"],
  ["sudo docker ps", B, "wrapper"],
  ["timeout 5 sudo docker ps", B, "wrapper"],
  ["echo a | xargs docker ps", B, "wrapper"],
  ["timeout 5 nice docker ps", U],
  ["time -p docker ps", B],
  ["nohup nice -n 3 docker ps", U],
  ["timeout 5 gh pr list", U],
  ["timeout 5 mytool run", B, "no-entry"],
  ["timeout abc docker ps || docker ps", B],
]);

each("shape", BASIC, [
  ["docker run $(echo x)", B, "substitution"],
  ["docker run `echo x`", B, "substitution"],
  ["docker run \"$(echo x)\"", B, "substitution"],
  ["(docker ps)", B, "subshell"],
  ["{ docker ps; }", B, "group"],
  ["if true; then docker ps; fi", B, "control-flow"],
  ["for i in 1 2; do docker ps; done", B, "control-flow"],
  ["while ! test -f done.txt; do docker ps; touch done.txt; done", B, "control-flow"],
  ["[ -f a.txt ] && docker ps", B, "test-brackets"],
  ["[[ -f a.txt ]] && docker ps", B, "test-brackets"],
  ["cd sub && docker ps && cd ..", B, "directory"],
  ["cd sub; docker ps; cd ..", B, "directory"],
  ["docker ps && cd sub && cd ..", B, "directory"],
  ["pushd sub && docker ps && popd", B, "directory"],
  ["eval \"docker ps\"", B, "runs-code"],
  ["export X=1 && docker ps", B, "shell-state"],
  ["X=1; docker ps", B, "unsafe-assignment"],
  ["CI=1; docker ps", U],
  ["LANG=C; docker ps", B],
  ["D=docker; $D ps", B],
  ["docker ps $HOME", U],
  ["docker ps ${HOME}", U],
  ["docker run -e A=$(date) img", B, "substitution"],
  ["docker ps <(echo x)", B, "process-substitution"],
  ["docker ps | tee out.txt", B],
  ["\"docker\" ps", B, "command-word"],
  ["'docker' ps", B, "command-word"],
  ["docker \"ps\"", U],
  ["docker ps\\\n--all", B],
  ["d\\ocker ps", B, "command-word"],
]);

// ---- programs with flags that keep a call in the sandbox -----------------------------------------------------------------------
const TOOLS = S(["git *", "docker *", "kubectl *", "aws *", "bash *", "sh *", "python *", "node *", "ruby *", "perl *", "npm *", "make *", "curl *", "gh *"]);

each("git", TOOLS, [
  ["git status", U],
  ["git --no-pager status", U],
  ["git -C sub status", B, "git-flag"],
  ["git -c core.pager=cat status", B, "git-flag"],
  ["git --git-dir=.git status", B, "git-flag"],
  ["git --work-tree=. status", B, "git-flag"],
  ["git --exec-path=/x status", B, "git-flag"],
  ["git clone https://example.invalid/y.git vendor/lib", U],
  ["git clone https://example.invalid/y.git ~/tools", B, "git-path"],
  ["git clone https://example.invalid/y.git /tmp/x", B, "git-path"],
  ["git clone https://example.invalid/y.git ../x", B, "git-path"],
  ["git clone https://example.invalid/y.git", U],
  ["git init sub", U],
  ["git init /tmp/x", B, "git-path"],
  ["git worktree add w", U],
  ["git worktree add ../w", B, "git-path"],
  ["git bundle create ../b.bundle HEAD", B, "git-path"],
  ["git bundle create b.bundle HEAD", U],
  ["git config user.name x", U],
  ["git config alias.x status", B, "git-config"],
  ["git config core.sshCommand ssh", B, "git-config"],
  ["git rebase -x ls HEAD~1", B, "git-flag"],
  ["git bisect run ./t.sh", B, "git-run"],
  ["git submodule foreach ls", B, "git-run"],
  ["git log --output=x", B, "git-flag"],
  ["git push origin main", U],
  ["git fetch --all", U],
]);

each("flag", TOOLS, [
  ["docker -H tcp://x ps", B, "risky-flag"],
  ["docker --host=tcp://x ps", B, "risky-flag"],
  ["docker ps -H tcp://x", B, "risky-flag"],
  ["docker --context x ps", B, "risky-flag"],
  ["docker ps --format x", U],
  ["kubectl --server=https://x get pods", B, "risky-flag"],
  ["kubectl get pods -s https://x", B, "risky-flag"],
  ["kubectl --kubeconfig=x get pods", B, "risky-flag"],
  ["kubectl get pods", U],
  ["aws s3 ls", U],
  ["aws s3 ls --profile x", B, "risky-flag"],
  ["aws --endpoint-url=http://x s3 ls", B, "risky-flag"],
  ["bash script.sh", U],
  ["bash -c \"docker ps\"", B, "interpreter"],
  ["bash -ec \"docker ps\"", B, "interpreter"],
  ["bash --rcfile x script.sh", B, "interpreter"],
  ["bash", B, "interpreter"],
  ["sh script.sh", U],
  ["sh -c \"docker ps\"", B, "interpreter"],
  ["python script.py", U],
  ["python -c \"print(1)\"", B, "interpreter"],
  ["python -m http.server", U],
  ["python -", B, "interpreter"],
  ["python3 script.py", B, "no-entry"],
  ["node app.js", U],
  ["node -e 1", B, "interpreter"],
  ["node --eval 1", B, "interpreter"],
  ["node -p 1", B, "interpreter"],
  ["node -r x app.js", B, "interpreter"],
  ["ruby -e 1", B, "interpreter"],
  ["ruby script.rb", U],
  ["perl -e 1", B, "interpreter"],
  ["perl script.pl", U],
  ["npm run build", U],
  ["npm test", U],
  ["make -f x test", U],
  ["curl https://example.invalid", U],
  ["curl -o out.txt https://example.invalid", U],
  ["gh pr list", U],
]);

// ---- the retry: dangerouslyDisableSandbox -------------------------------------------------------------------------------------
const EXC = ["docker *"];
each("retry-default", S(EXC), [
  ["gh pr list", B, "no-entry"],
  ["gh pr list", U, null, { retry: true }],
  ["docker ps", U, null, { retry: true }],
  ["docker ps && gh pr list", U, null, { retry: true }],
  ["gh pr list > out.txt", U, null, { retry: true }],
]);
each("retry-strict", S(EXC, { allowUnsandboxedCommands: false }), [
  ["gh pr list", B, "no-entry"],
  ["gh pr list", B, null, { retry: true }],
  ["docker ps", U, null, { retry: true }],
  ["docker ps && gh pr list", B, null, { retry: true }],
]);
each("retry-user-false", { user: { sandbox: { enabled: true, allowUnsandboxedCommands: false, excludedCommands: EXC } }, project: { sandbox: { allowUnsandboxedCommands: true } } }, [
  ["gh pr list", B, null, { retry: true }],
  ["docker ps", U, null, { retry: true }],
]);
each("retry-project-false", { user: { sandbox: { enabled: true, excludedCommands: EXC } }, project: { sandbox: { allowUnsandboxedCommands: false } } }, [
  ["gh pr list", B, null, { retry: true }],
  ["docker ps", U],
]);
each("retry-true", { user: { sandbox: { enabled: true, excludedCommands: EXC, allowUnsandboxedCommands: true } } }, [
  ["gh pr list", U, null, { retry: true }],
  ["gh pr list", B, "no-entry"],
]);

// ---- where the entries come from, and a sandbox that is off ------------------------------------------------------------------------
each("files", { user: { sandbox: { enabled: true, excludedCommands: ["git status"] } }, project: { sandbox: { excludedCommands: ["docker *"] } }, local: { sandbox: { excludedCommands: ["gh *"] } } }, [
  ["git status", U],
  ["docker ps", U],
  ["gh pr list", U],
  ["git status && docker ps && gh pr list", U],
  ["npm test", B, "no-entry"],
]);
each("off", { user: { sandbox: { excludedCommands: ["docker *"] } } }, [
  ["docker ps", U],
  ["mytool run", U],
  ["mytool run > out.txt", U],
]);
each("off-false", { user: { sandbox: { enabled: false, excludedCommands: ["docker *"] } } }, [
  ["mytool run", U],
]);
each("project-enabled", { project: { sandbox: { enabled: true, excludedCommands: ["docker *"] } } }, [
  ["docker ps", U],
  ["mytool run", B, "no-entry"],
]);
each("local-off", { user: { sandbox: { enabled: true, excludedCommands: ["docker *"] } }, local: { sandbox: { enabled: false } } }, [
  ["mytool run", U],
]);
each("dup", S(["docker *", "docker *", "docker ps"]), [
  ["docker ps", U],
  ["docker images", U],
]);
each("star", S(["*"]), [
  ["docker ps", U],
  ["mytool run", U],
  ["sudo mytool run", B, "wrapper"],
  ["cd sub && mytool run && cd ..", B, "directory"],
  ["mytool run > out.txt", B, "redirect"],
]);
each("space", S(["docker  ps", " dockerx *", "mytool run "]), [
  ["docker ps", B],
  ["docker  ps", U],
  ["mytool run", B],
  ["dockerx images", U],
]);
each("prefix-forms", S(["docker:*", "gh pr *", "my*l run", "make test"]), [
  ["docker ps", U],
  ["docker", U],
  ["dockerx ps", B, "no-entry"],
  ["gh pr list", U],
  ["gh pr", U],
  ["gh issue list", B, "no-entry"],
  ["mytool run", U],
  ["make test", U],
  ["make test x", B, "no-entry"],
]);

// ---- managed settings ------------------------------------------------------------------------------------------------------------
// The rows below need a managed-settings.json in the system folder, which the real Claude Code reads from there and from nowhere
// else. test/e2e-managed.test.mjs writes it with sudo on a CI runner (test/managed.mjs) and runs these rows one group at a time;
// the main table (test/e2e-table.test.mjs) leaves them out. `why` is held to them without a binary, in test/why-table.test.mjs.
const M = (managed, rest = {}) => ({ managed: { sandbox: { enabled: true, ...managed } }, ...rest });
const PROJECT_TOOL = { sandbox: { excludedCommands: ["mytool *"], allowUnsandboxedCommands: true } };

each("managed-strict", M({ allowUnsandboxedCommands: false }, { project: PROJECT_TOOL }), [
  ["mytool run", B],
  ["mytool run", B, null, { retry: true }],
]);
each("managed-entries", M({ excludedCommands: ["mytool *"], allowUnsandboxedCommands: false }, { project: { sandbox: { excludedCommands: ["git status"] } } }), [
  ["mytool run", U],
  ["git status", B],
  ["mytool run && git status", B],
]);
each("managed-plain", M({}, { project: PROJECT_TOOL }), [
  ["mytool run", U],
  ["git status", U, null, { retry: true }],
]);
each("managed-domains-only", M({ network: { allowManagedDomainsOnly: true } }, { project: PROJECT_TOOL, user: { sandbox: { excludedCommands: ["git status"] } } }), [
  ["mytool run", B],
  ["git status", U],
]);
each("managed-other-platform", M({ enabledPlatforms: ["windows"] }, { project: PROJECT_TOOL }), [
  ["mytool run", U],
  ["git status", U],
]);
each("managed-platform-typo", M({ enabledPlatforms: ["mac"] }, { project: PROJECT_TOOL }), [
  ["mytool run", U],
]);
each("managed-this-platform", M({ enabledPlatforms: ["linux", "macos"] }, { project: PROJECT_TOOL }), [
  ["mytool run", U],
  ["git status", B, "no-entry"],
]);
each("managed-user-strict", M({}, { user: { sandbox: { allowUnsandboxedCommands: false } }, project: PROJECT_TOOL }), [
  ["mytool run", U],
  ["git status", B, null, { retry: true }],
]);

/** Rows for the main table: the ones that need nothing outside the test's own folders. */
export const tableRows = rows.filter((r) => !(r.settings && r.settings.managed));
/** Rows that need a managed-settings.json in the system folder. */
export const managedRows = rows.filter((r) => r.settings && r.settings.managed);

const groupsOf = (list) => {
  const out = new Map();
  for (const r of list) {
    const key = JSON.stringify(r.settings);
    if (!out.has(key)) out.set(key, { settings: r.settings, rows: [] });
    out.get(key).rows.push(r);
  }
  return [...out.values()];
};
/** The groups of the main table, each with the settings every row of it shares. */
export const groups = () => groupsOf(tableRows);
/** The groups of the rows that need managed settings. */
export const managedGroups = () => groupsOf(managedRows);

// ---- who approves the call: the permission mode default, no allow rule for Bash -------------------------------------------------
// `expect` is what `claude -p` did: "approved" (the call ran), "asked" (it needs a prompt, which -p cannot give: nothing ran) or
// "denied" (a deny rule refused it).
export const approvals = [];
let acount = 0;
function approve(group, settings, list) {
  for (const [command, expect, extra] of list) approvals.push({ id: `${group}-${String(++acount).padStart(3, "0")}`, group, settings, command, expect, ...(extra || {}) });
}
const P = (perm, sandbox = {}) => ({ user: { sandbox: { enabled: true, ...sandbox }, permissions: perm } });
approve("approval-basic", P({}, { excludedCommands: ["gh *"] }), [
  ["mytool run", "approved"],
  ["mytool run > out.txt", "approved"],
  ["gh pr list", "asked"],
  ["FOO=bar mytool run", "asked"],
  ["make CC=clang", "asked"],
  ["eval \"mytool run\"", "asked"],
  ["cd sub && mytool run && cd ..", "approved"],
  ["mytool run && gh pr list", "approved"],
  ["docker ps", "approved"], // docker ps only reads: Claude Code passes it with or without a sandbox
  ["curl -sS -m 10 -o /dev/null http://sandbox-doctor-probe.invalid/", "approved"],
  ["curl -sS -m 10 -o /dev/null -w \"http=%{http_code}\n\" http://sandbox-doctor-probe.invalid/", "asked"],
  ["curl -sS -m 10 -o /dev/null -w \"%{http_code}\" http://sandbox-doctor-probe.invalid/", "approved"],
]);
approve("approval-off", { user: { sandbox: { excludedCommands: ["gh *"] } } }, [["mytool run", "asked"]]);
approve("approval-off-explicit", { user: { sandbox: { enabled: false, autoAllowBashIfSandboxed: true } } }, [["mytool run", "asked"]]);
approve("approval-noauto", P({}, { autoAllowBashIfSandboxed: false }), [["mytool run", "asked"]]);
approve("approval-deny", P({ deny: ["Bash(docker *)"] }), [["docker ps", "denied"], ["mytool run", "approved"], ["mytool run && docker ps", "denied"]]);
approve("approval-ask", P({ ask: ["Bash(git push *)"] }), [["git push origin main", "asked"], ["git fetch --all", "approved"]]);
approve("approval-ask-bare", P({ ask: ["Bash"] }, { excludedCommands: ["gh *"] }), [["mytool run", "approved"], ["gh pr list", "asked"]]);
approve("approval-allow", P({ allow: ["Bash(gh *)"] }, { excludedCommands: ["gh *"] }), [["gh pr list", "approved"], ["mytool run", "approved"]]);

export const approvalGroups = () => {
  const out = new Map();
  for (const r of approvals) {
    const key = JSON.stringify(r.settings);
    if (!out.has(key)) out.set(key, { settings: r.settings, rows: [] });
    out.get(key).rows.push(r);
  }
  return [...out.values()];
};
