// The lint: each rule once, with the settings that trigger it and the machine it is about, and the settings that must raise nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { run, world } from "./helpers.mjs";
import { RULES, domainProblem } from "../src/lint.mjs";
import { MAC, WINDOWS, ubuntu } from "./fakesys.mjs";

const HOSTS = { linux: () => ubuntu({ profile: true }), linuxNoBwrap: () => ubuntu({ bwrap: false, socat: false }), mac: MAC, windows: WINDOWS };

/** Lint a world with the given files on a machine; returns the findings as "severity id" strings (and the findings). */
async function lint(files, host = "linux") {
  const w = world("lint");
  for (const [scope, value] of Object.entries(files)) {
    if (scope === "user") w.user(value); else if (scope === "project") w.project(value); else if (scope === "local") w.local(value); else if (scope === "managed") w.managed(value);
  }
  const r = await run(["lint", "--json"], w, { sys: HOSTS[host]() });
  const j = r.json();
  return { code: r.code, findings: j.findings, ids: j.findings.map((f) => `${f.severity} ${f.id}`).sort(), counts: j.counts };
}
/** Every finding the table below produced, for the test of the rules at the end. */
const seen = [];
const S = (sandbox) => ({ user: { sandbox: { enabled: true, ...sandbox } } });

// settings, machine, and the findings the lint gives (an empty list: none)
const TABLE = [
  ["a clean block", S({ excludedCommands: ["docker *", "git status"], network: { allowedDomains: ["github.com", "registry.npmjs.org"] } }), "linux", []],
  ["a bare entry", S({ excludedCommands: ["docker"] }), "linux", ["warning bare-entry"]],
  ["a multi-word exact entry is fine", S({ excludedCommands: ["git status"] }), "linux", []],
  ["an entry for sudo", S({ excludedCommands: ["sudo *"] }), "linux", ["warning dead-entry"]],
  ["an entry for cd", S({ excludedCommands: ["cd *"] }), "linux", ["warning dead-entry"]],
  ["an entry for bash -c", S({ excludedCommands: ["bash -c *"] }), "linux", ["warning dead-entry"]],
  ["an entry for git -C", S({ excludedCommands: ["git -C *"] }), "linux", ["warning dead-entry"]],
  ["an entry with a redirection", S({ excludedCommands: ["docker build . > out.log"] }), "linux", ["warning dead-entry"]],
  ["an entry with a leading assignment", S({ excludedCommands: ["FOO=bar docker *"] }), "linux", ["warning dead-entry"]],
  ["an entry with && in it", S({ excludedCommands: ["npm ci && docker *"] }), "linux", ["warning dead-entry"]],
  ["an empty entry", S({ excludedCommands: [""] }), "linux", ["warning dead-entry"]],
  ["the star entry", S({ excludedCommands: ["*"] }), "linux", ["warning all-entry"]],
  ["an excluded interpreter", S({ excludedCommands: ["python *"] }), "linux", ["note broad-entry"]],
  ["a scheme in a domain", S({ network: { allowedDomains: ["https://github.com"] } }), "linux", ["warning domain-scheme"]],
  ["a path in a domain", S({ network: { allowedDomains: ["github.com/anthropics"] } }), "linux", ["warning domain-path"]],
  ["a bad port in a domain", S({ network: { allowedDomains: ["github.com:abc", "github.com:0", "github.com:65536", "github.com:080"] } }), "linux", ["warning domain-port", "warning domain-port", "warning domain-port", "warning domain-port"]],
  ["an IPv6 domain without brackets", S({ network: { allowedDomains: ["::1:443"] } }), "linux", ["warning domain-ipv6"]],
  ["a bracketed IPv6 domain", S({ network: { allowedDomains: ["[::1]", "[::1]:443"] } }), "linux", []],
  ["a wildcard that is not the first label", S({ network: { allowedDomains: ["api.*.com"] } }), "linux", ["warning domain-wildcard"]],
  ["a wildcard for subdomains, without the domain itself", S({ network: { allowedDomains: ["*.github.com"] } }), "linux", ["note wildcard-apex"]],
  ["a wildcard and the domain", S({ network: { allowedDomains: ["*.github.com", "github.com"] } }), "linux", []],
  ["a denied domain with a scheme", S({ network: { deniedDomains: ["http://evil.test"] } }), "linux", ["warning domain-scheme"]],
  ["an empty domain, a domain with a space and one with characters a host name does not have", S({ network: { allowedDomains: ["", " github.com", "a_b!.com"] } }), "linux", ["warning domain-empty", "warning domain-space", "warning domain-chars"]],
  ["failIfUnavailable where bubblewrap is missing", S({ failIfUnavailable: true }), "linuxNoBwrap", ["error fail-if-unavailable"]],
  ["failIfUnavailable on Windows", S({ failIfUnavailable: true }), "windows", ["error fail-if-unavailable"]],
  ["failIfUnavailable where the sandbox starts", S({ failIfUnavailable: true }), "linux", []],
  ["sandbox.enabled on Windows without failIfUnavailable", S({}), "windows", ["note no-sandbox-here"]],
  ["enableWeakerNetworkIsolation off macOS", S({ enableWeakerNetworkIsolation: true }), "linux", ["warning inert-here"]],
  ["enableWeakerNetworkIsolation on macOS", S({ enableWeakerNetworkIsolation: true }), "mac", []],
  ["enableWeakerNestedSandbox on macOS", S({ enableWeakerNestedSandbox: true }), "mac", ["warning inert-here", "warning weaker-nested"]],
  ["enableWeakerNestedSandbox on Linux", S({ enableWeakerNestedSandbox: true }), "linux", ["warning weaker-nested"]],
  ["allowLocalBinding on Linux", S({ network: { allowLocalBinding: true } }), "linux", ["warning inert-here"]],
  ["allowAppleEvents in a project file", { user: { sandbox: { enabled: true } }, project: { sandbox: { allowAppleEvents: true } } }, "mac", ["warning key-scope"]],
  ["allowAppleEvents in the user file on Linux", S({ allowAppleEvents: true }), "linux", ["warning inert-here"]],
  ["bwrapPath and socatPath in the user file", S({ bwrapPath: "/opt/bwrap", socatPath: "/opt/socat" }), "linux", ["warning key-scope", "warning key-scope"]],
  ["bwrapPath in managed settings", { managed: { sandbox: { enabled: true, bwrapPath: "/opt/bwrap" } } }, "linux", []],
  ["a relative bwrapPath in managed settings", { managed: { sandbox: { enabled: true, bwrapPath: "bwrap" } } }, "linux", ["warning relative-path"]],
  ["enabledPlatforms in the user file", S({ enabledPlatforms: ["macos"] }), "linux", ["warning key-scope"]],
  ["enabledPlatforms in managed settings that leaves this system out", { managed: { sandbox: { enabledPlatforms: ["macos"] } }, user: { sandbox: { enabled: true } } }, "linux", ["warning platform-excluded"]],
  ["an enabledPlatforms name that is none", { managed: { sandbox: { enabledPlatforms: ["mac", "linux"] } }, user: { sandbox: { enabled: true } } }, "linux", ["warning platform-name"]],
  ["autoAllowBashIfSandboxed with the sandbox off", { user: { sandbox: { autoAllowBashIfSandboxed: true } } }, "linux", ["warning auto-allow-without-sandbox"]],
  ["autoAllowBashIfSandboxed with the sandbox on", S({ autoAllowBashIfSandboxed: false }), "linux", []],
  ["a sandbox block without enabled", { user: { sandbox: { excludedCommands: ["docker *"] } } }, "linux", ["note enabled-unset"]],
  ["a typo in a key", S({ enableWeakerNestedSandbx: true }), "linux", ["warning unknown-key"]],
  ["a nested typo", S({ network: { allowedDomain: [] } }), "linux", ["warning unknown-key"]],
  ["allowWrite for a protected file", S({ filesystem: { allowWrite: ["./.bashrc", "~/.claude/settings.json", "./.claude/skills"] } }), "linux", ["warning protected-path", "warning protected-path", "warning protected-path"]],
  ["allowWrite for an ordinary folder", S({ filesystem: { allowWrite: ["/tmp/build", "~/.kube", "./out"] } }), "linux", []],
  ["a wildcard in allowWrite on Linux", S({ filesystem: { allowWrite: ["./out/*.log"] } }), "linux", ["warning write-glob-linux"]],
  ["a wildcard in allowWrite on macOS", S({ filesystem: { allowWrite: ["./out/*.log"] } }), "mac", []],
  ["a mask entry in a project file", { user: { sandbox: { enabled: true } }, project: { sandbox: { credentials: { files: [{ path: "~/.aws/credentials", mode: "mask" }] } } } }, "linux", ["warning mask-in-repository"]],
  ["a project's true held by the user's false", { user: { sandbox: { enabled: true, allowUnsandboxedCommands: false } }, project: { sandbox: { allowUnsandboxedCommands: true } } }, "linux", ["note retry-held"]],
  ["entries a repository cannot add under an admin-required sandbox", { managed: { sandbox: { enabled: true, allowUnsandboxedCommands: false } }, project: { sandbox: { excludedCommands: ["docker *"], network: { allowedDomains: ["a.com"] } } } }, "linux", ["warning admin-required", "warning admin-required"]],
  ["a settings file with a comment that has a sandbox block", { project: '{ // c\n "sandbox": { "enabled": true } }' }, "linux", ["error file-ignored"]],
  ["a value of the wrong type", { project: { sandbox: { enabled: "yes" } } }, "linux", ["error file-ignored"]],
  ["no sandbox keys at all", { user: { model: "x" } }, "linux", []],
];

for (const [name, files, host, want] of TABLE) {
  test(`lint: ${name}`, async () => {
    const f = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? v : v]));
    const w = world("lint");
    for (const [scope, value] of Object.entries(f)) {
      const file = { user: w.userFile, project: w.projectFile, local: w.localFile, managed: w.managedFile }[scope];
      w.write(file, value);
    }
    const r = await run(["lint", "--json"], w, { sys: HOSTS[host]() });
    const j = r.json();
    seen.push(...j.findings);
    assert.deepEqual(j.findings.map((x) => `${x.severity} ${x.id}`).sort(), [...want].sort(), JSON.stringify(j.findings.map((x) => x.message)));
    assert.equal(r.code, want.some((x) => /^(error|warning)/.test(x)) ? 1 : 0, "exit 1 on an error or a warning");
  });
}

test("a finding names the file, the line and the key, and says what to do", async () => {
  const w = world("lint-shape");
  w.write(w.userFile, '{\n  "sandbox": {\n    "enabled": true,\n    "excludedCommands": [\n      "docker *",\n      "docker"\n    ]\n  }\n}\n');
  const r = await run(["lint", "--json"], w, { sys: ubuntu({ profile: true }) });
  const f = r.json().findings[0];
  assert.equal(f.id, "bare-entry");
  assert.equal(f.scope, "user");
  assert.equal(f.display, "~/.claude/settings.json");
  assert.equal(f.line, 6);
  assert.equal(f.keyPath, "sandbox.excludedCommands");
  assert.match(f.message, /matches only the bare command "docker" with no arguments/);
  assert.match(f.fix, /"docker \*"/);
  const text = (await run(["lint"], w, { sys: ubuntu({ profile: true }) })).out;
  assert.match(text, /~\/\.claude\/settings\.json {2}user settings/);
  assert.match(text, /warning bare-entry +line 6 +sandbox\.excludedCommands/);
  assert.match(text, /0 errors, 1 warning, 0 notes \(1 settings file read\)/);
});

test("lint --markdown is the short form for the skill: at most 12 findings, 300 characters a line, and it always exits 0", async () => {
  const w = world("lint-md");
  const many = Array.from({ length: 30 }, (_, i) => `bare${i}`);
  w.user({ sandbox: { enabled: true, excludedCommands: many } });
  const r = await run(["lint", "--markdown"], w, { sys: ubuntu({ profile: true }) });
  assert.equal(r.code, 0);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 2 + 12 + 1);
  assert.match(lines[0], /^## sandbox-doctor lint: /);
  assert.match(lines[1], /^1 settings file read, 0 errors, 30 warnings, 0 notes\. System: Linux, Ubuntu 24\.04\.5 LTS\.$/);
  assert.match(lines.at(-1), /^- \.\.\. and 18 more \(run `claude-sandbox-doctor lint`\)$/);
  for (const l of lines) assert.ok(l.length <= 300, `${l.length}`);
  const clean = await run(["lint", "--markdown"], world("lint-md-clean"), { sys: ubuntu({ profile: true }) });
  assert.match(clean.out, /No error and no warning\./);
  assert.equal(clean.code, 0);
});

test("domainProblem: what the proxy cannot match", () => {
  const bad = { "https://github.com": "domain-scheme", "http://x": "domain-scheme", "github.com/foo": "domain-path", "github.com?x=1": "domain-path", "user@github.com": "domain-path", "github.com:abc": "domain-port", "github.com:0": "domain-port", "github.com:65536": "domain-port", "github.com:00443": "domain-port", "::1:443": "domain-ipv6", "fe80::1": "domain-ipv6", "api.*.com": "domain-wildcard", "github.*": "domain-wildcard", "**": "domain-wildcard", "": "domain-empty", " github.com": "domain-space", "git hub.com": "domain-chars", "[::1]:abc": "domain-port" };
  for (const [entry, code] of Object.entries(bad)) assert.equal((domainProblem(entry) || {}).code, code, JSON.stringify(entry));
  for (const ok of ["github.com", "GitHub.com", "*.github.com", "*", "api.example.com:443", "*.example.com:8080", "[::1]", "[::1]:443", "127.0.0.1", "127.0.0.1:8080", "localhost", "my_host.test", "xn--mnchen-3ya.de"]) assert.equal(domainProblem(ok), null, ok);
  assert.equal(domainProblem(7).code, "domain-type");
});

test("RULES: every finding the table produced is a rule with the severity and the basis that RULES gives, and every rule was produced", () => {
  const ids = new Set(seen.map((f) => f.id));
  for (const f of seen) {
    const rule = RULES[f.id];
    assert.ok(rule, `${f.id} is in RULES`);
    assert.equal(f.severity, rule.severity, `${f.id}: severity`);
    if (rule.basis !== "mixed") assert.equal(f.basis, rule.basis, `${f.id}: basis`);
    assert.ok(["binary", "docs"].includes(f.basis), `${f.id}: basis ${f.basis}`);
  }
  assert.deepEqual(Object.keys(RULES).filter((id) => !ids.has(id)), [], "a rule that no row of the table triggers");
  for (const [id, rule] of Object.entries(RULES)) assert.ok(rule.what && rule.what.length > 20, `${id} says what it finds`);
});

test("key-scope: the basis is binary for a key whose scope was put to the binary, and docs for the rest", async () => {
  const a = await lint({ project: { sandbox: { enabled: true, bwrapPath: "/opt/bwrap", allowAppleEvents: true } } });
  const basis = Object.fromEntries(a.findings.filter((f) => f.id === "key-scope").map((f) => [f.keyPath, f.basis]));
  assert.deepEqual(basis, { "sandbox.bwrapPath": "binary", "sandbox.allowAppleEvents": "docs" });
});
