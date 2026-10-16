// What `claude doctor` of the real Claude Code says about sandbox settings, which the lint relies on: a value of the wrong type
// (the whole file is ignored), the domain spellings it calls unreliable, and what it says nothing about (a key the sandbox block
// does not have, a key only managed settings may set, an enabledPlatforms name that is none). It runs on every system, with no
// sandbox: `claude doctor` reads the files.
import test from "node:test";
import assert from "node:assert/strict";
import { claudeInfo, claudeNoApi, put, sandbox, skip } from "./claude-sandbox.mjs";
import { run, world } from "./helpers.mjs";

/** The text of `claude doctor` about settings: the Invalid settings block and the sandbox warning, with the paths cut. */
async function doctor(files) {
  const sb = sandbox("doctor");
  if (files.user) put(sb.user, files.user);
  if (files.project) put(sb.project, files.project);
  const r = await claudeNoApi(sb, ["doctor"]);
  assert.equal(r.code, 0, r.out + r.err);
  const text = r.out.split(sb.root).join("<world>").split(sb.root.replace(/\\/g, "/")).join("<world>");
  return { text, invalid: (/Invalid settings\n((?:- .*\n?)+)/.exec(text) || [, ""])[1].trim().split("\n").filter(Boolean), sandboxWarning: (/Sandbox network domain entries have unreliable spellings\n\s*Fix: Found: ([^.]*)\./.exec(text) || [])[1] || null };
}

test("claude doctor lists a value of the wrong type in the sandbox block under Invalid settings, and the lint says the same file is ignored", { skip: skip(), timeout: 200000 }, async () => {
  const d = await doctor({ user: { sandbox: { excludedCommands: "docker" } }, project: { sandbox: { enabled: "yes", network: { allowedDomains: "x" } } } });
  const joined = d.invalid.join("\n");
  assert.match(joined, /sandbox\.excludedCommands: Expected array, but received string/);
  assert.match(joined, /sandbox\.enabled: Expected boolean, but received string/);
  const w = world("doctor-lint");
  w.user({ sandbox: { excludedCommands: "docker" } });
  w.project({ sandbox: { enabled: "yes", network: { allowedDomains: "x" } } });
  const l = (await run(["lint", "--json"], w)).json();
  assert.deepEqual(l.findings.filter((f) => f.id === "file-ignored").map((f) => f.scope).sort(), ["project", "user"]);
});

test("claude doctor calls an IPv6 entry without brackets unreliable, and says nothing about the other spellings that the lint calls dead", { skip: skip(), timeout: 200000 }, async (t) => {
  const d = await doctor({ user: { sandbox: { enabled: true, network: { allowedDomains: ["::1:443", "[::1]", "[::1]:443", "https://github.com", "github.com/foo", "github.com:abc", "*.github.com:443", "api.*.com"] } } } });
  assert.equal(d.sandboxWarning, "::1:443", "only the IPv6 entry without brackets is found");
  t.diagnostic(`Claude Code ${claudeInfo().version}: Sandbox network domain entries have unreliable spellings. Found: ${d.sandboxWarning}`);
});

test("claude doctor says nothing about a sandbox key that does not exist, a key only managed settings may set, or a platform name that is none", { skip: skip(), timeout: 200000 }, async () => {
  const d = await doctor({ user: { sandbox: { enabled: true, enableWeakerNestedSandbx: true, bwrapPath: "/opt/bwrap", socatPath: "/opt/socat", enabledPlatforms: ["mac"] } } });
  assert.deepEqual(d.invalid, []);
  assert.equal(d.sandboxWarning, null);
  assert.doesNotMatch(d.text, /enableWeakerNestedSandbx|bwrapPath|enabledPlatforms/);
  const w = world("doctor-quiet");
  w.user({ sandbox: { enabled: true, enableWeakerNestedSandbx: true, bwrapPath: "/opt/bwrap", enabledPlatforms: ["mac"] } });
  // what the lint says about this machine (no sandbox here, a Linux-only key) is left out: it depends on the system the test runs on
  const ids = (await run(["lint", "--json"], w)).json().findings.map((f) => f.id).filter((id) => !["inert-here", "no-sandbox-here"].includes(id)).sort();
  assert.deepEqual(ids, ["key-scope", "key-scope", "platform-name", "unknown-key"].sort());
});
