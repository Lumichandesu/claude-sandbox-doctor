// Managed settings put to the real Claude Code, on a CI runner only (test/managed.mjs writes /etc/claude-code or
// /Library/Application Support/ClaudeCode with sudo and removes the file again): what an admin-required sandbox does with the
// entries of a repository, what enabledPlatforms does when it is managed, the managed bwrapPath, and that the tool reads the same
// system folder. These checks run alone in their step, one at a time, because the folder is the machine's.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { claudeInfo, put, skip, IS_WIN } from "./claude-sandbox.mjs";
import { runGroups, runSession } from "./oracle.mjs";
import { managedGroups, managedRows } from "./why-table.mjs";
import { MANAGED_DIR, clearManaged, setManaged, skipManaged } from "./managed.mjs";
import { realSys } from "../src/host.mjs";
import { runCli, world } from "./helpers.mjs";

const SKIP = skip() || skipManaged() || (IS_WIN && "the Bash sandbox exists on Linux, WSL2 and macOS only");
const curl = (host) => `curl -sS -m 10 -o /dev/null -w "%{http_code}" http://${host}/`;
const refused = (text, host) => text.includes("403") || text.includes(`network-outbound ${host}:80`);

test("the rows that need managed settings: where the real Claude Code runs each call is where why says", { skip: SKIP, timeout: 900000 }, async (t) => {
  const results = await runGroups(managedGroups(), { limit: 1 });
  const byId = new Map(results.map((r) => [r.row.id, r]));
  const differ = [];
  for (const row of managedRows) {
    const got = byId.get(row.id);
    if (!got || got.place === null) { differ.push(`${row.id} ${JSON.stringify(row.command)}${row.retry ? " [retry]" : ""}: nothing ran (${got ? JSON.stringify(String(got.text).slice(0, 100)) : "no result"})`); continue; }
    if (got.place !== row.expect) differ.push(`${row.id} ${JSON.stringify(row.command)}${row.retry ? " [retry]" : ""}: expected ${row.expect}, the binary ran it ${got.place}`);
  }
  t.diagnostic(`Claude Code ${claudeInfo().version}: ${managedRows.length - differ.length} of ${managedRows.length} rows with managed settings gave the recorded answer`);
  for (const d of differ) t.diagnostic(`  differs: ${d}`);
  assert.deepEqual(differ, []);
  assert.equal(fs.existsSync(path.join(MANAGED_DIR, "managed-settings.json")), false, "the managed file was removed again");
});

test("an admin-required sandbox ignores the network entries of a repository and of the user: only the managed allowedDomains count with allowManagedDomainsOnly", { skip: SKIP, timeout: 300000 }, async (t) => {
  try {
    const managed = { sandbox: { enabled: true, network: { allowManagedDomainsOnly: true, allowedDomains: ["managed-a.invalid"] } } };
    const r = await runSession({
      label: "managed-domains",
      user: { sandbox: { network: { allowedDomains: ["user-a.invalid"] } } },
      project: { sandbox: { network: { allowedDomains: ["project-a.invalid"] } } },
      programs: [],
      commands: [curl("managed-a.invalid"), curl("user-a.invalid"), curl("project-a.invalid"), curl("other-a.invalid")],
      setup: () => setManaged(managed),
    });
    const [m, u, p, o] = r.calls.map((c) => c.text);
    t.diagnostic(`Claude Code ${claudeInfo().version}: managed ${JSON.stringify(m.slice(0, 80))}; user ${JSON.stringify(u.slice(0, 80))}; project ${JSON.stringify(p.slice(0, 80))}; other ${JSON.stringify(o.slice(0, 80))}`);
    assert.equal(refused(m, "managed-a.invalid"), false, "a managed allowedDomains entry lets the request through");
    assert.equal(refused(u, "user-a.invalid"), true, "the user's entry is ignored");
    assert.equal(refused(p, "project-a.invalid"), true, "the project's entry is ignored");
    assert.equal(refused(o, "other-a.invalid"), true);
  } finally { clearManaged(); }
});

test("permissions.defaultMode bypassPermissions in managed settings lets a host that is not allowed through, as the same setting in the user file does; strictAllowlist in the user file holds against it", { skip: SKIP, timeout: 300000 }, async (t) => {
  try {
    const run = (label, user) => runSession({ label, mode: null, user: { sandbox: { enabled: true }, ...user }, project: {}, programs: [], commands: [curl("managed-a.invalid")], setup: () => setManaged({ permissions: { defaultMode: "bypassPermissions" } }) });
    const open = await run("managed-bypass", {});
    const strict = await run("managed-bypass-strict", { sandbox: { enabled: true, network: { strictAllowlist: true } } });
    t.diagnostic(`Claude Code ${claudeInfo().version}: managed defaultMode bypassPermissions -> ${JSON.stringify(open.calls[0].text.slice(0, 40))}; with strictAllowlist in the user file -> ${JSON.stringify(strict.calls[0].text.slice(0, 40))}`);
    assert.equal(refused(open.calls[0].text, "managed-a.invalid"), false, "let through");
    assert.equal(refused(strict.calls[0].text, "managed-a.invalid"), true, "refused with strictAllowlist");
  } finally { clearManaged(); }
});

test("sandbox.bwrapPath in managed settings is used, and a relative one is dropped for the bwrap on the PATH", { skip: SKIP || (process.platform !== "linux" && "bubblewrap exists on Linux only"), timeout: 300000 }, async (t) => {
  const real = realSys().which("bwrap");
  const stand = (dir, name, tag) => put(path.join(dir, name), ["#!/bin/sh", `if [ -n "$CSD_ARGV" ]; then printf '%s\\0' "$@" > "$CSD_ARGV/${tag}-$$.argv"; fi`, `exec "${real}" "$@"`, ""].join("\n"), 0o755);
  const seen = {};
  for (const variant of ["absolute", "relative"]) {
    try {
      const r = await runSession({
        label: `managed-bwrap-${variant}`,
        project: {},
        programs: [],
        commands: ["echo hi; printenv SANDBOX_RUNTIME"],
        setup: (sb) => {
          fs.mkdirSync(path.join(sb.root, "argv"), { recursive: true });
          stand(sb.bin, "bwrap", "path-bwrap");
          stand(path.join(sb.root, "alt"), "bwrap", "alt-bwrap");
          put(sb.user, { sandbox: { enabled: true } });
          setManaged({ sandbox: { bwrapPath: variant === "absolute" ? path.join(sb.root, "alt", "bwrap") : "alt/bwrap" } });
        },
        env: (sb) => ({ CSD_ARGV: path.join(sb.root, "argv") }),
        user: undefined,
      });
      const names = fs.readdirSync(path.join(r.sb.root, "argv"));
      seen[variant] = { alt: names.filter((n) => n.startsWith("alt-")).length, path: names.filter((n) => n.startsWith("path-")).length, text: r.calls[0].text.replace(/\s+/g, " ").slice(0, 100) };
    } finally { clearManaged(); }
  }
  t.diagnostic(`Claude Code ${claudeInfo().version}: ${JSON.stringify(seen)}`);
  assert.ok(seen.absolute.alt > 0, "the program at the managed bwrapPath ran");
  assert.equal(seen.absolute.path, 0, "and the one on the PATH did not");
  assert.equal(seen.relative.alt, 0, "a relative bwrapPath is not used");
  assert.ok(seen.relative.path > 0, "the bwrap on the PATH ran instead");
  assert.match(seen.relative.text, /hi/);
});

test("the tool reads the same system folder: show, lint and why see the managed file and the entries it makes ignored", { skip: SKIP, timeout: 300000 }, async () => {
  try {
    setManaged({ sandbox: { enabled: true, allowUnsandboxedCommands: false } });
    const w = world("managed-cli");
    w.project({ sandbox: { excludedCommands: ["mytool *"], allowUnsandboxedCommands: true } });
    const env = { ...w.env, CLAUDE_SANDBOX_DOCTOR_MANAGED_DIR: "" };
    const show = JSON.parse(runCli(["show", "--json"], { cwd: w.work, env }).out);
    assert.equal(show.files.find((f) => f.scope === "managed").exists, true, "the managed file is found in the system folder");
    assert.equal(show.effective.adminRequired, true);
    const lint = JSON.parse(runCli(["lint", "--json"], { cwd: w.work, env }).out);
    assert.ok(lint.findings.some((f) => f.id === "admin-required"), "lint says the repository's entries are ignored");
    const why = JSON.parse(runCli(["why", "mytool run", "--json"], { cwd: w.work, env }).out);
    assert.equal(why.runs, "sandboxed");
  } finally { clearManaged(); }
});
