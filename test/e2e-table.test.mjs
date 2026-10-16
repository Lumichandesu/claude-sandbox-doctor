// The table of test/why-table.mjs put to the real Claude Code, with its sandbox on, at zero tokens (see test/oracle.mjs). It runs
// where the sandbox exists: Linux with bubblewrap and socat, and macOS. On the versions the rows were recorded from, every row
// must give the recorded answer. A newer version may change something, and then the rows that matter most must still agree and
// at least 95 in 100 of all of them; the rest are listed as diagnostics, so that a drift is seen in the CI log without every
// release turning the job red.
import test from "node:test";
import assert from "node:assert/strict";
import { claudeInfo, skip, IS_WIN } from "./claude-sandbox.mjs";
import { approvalGroups, approvals, groups, tableRows as rows } from "./why-table.mjs";
import { approvalOf, runGroups } from "./oracle.mjs";

const RECORDED = [];
const SKIP = skip() || (IS_WIN && "the Bash sandbox exists on Linux, WSL2 and macOS only");

test("the table of calls put to the binary: every row", { skip: SKIP, timeout: 2400000 }, async (t) => {
  const version = claudeInfo().number;
  const known = RECORDED.includes(version);
  const results = await runGroups(groups(), { limit: process.platform === "darwin" ? 3 : 4 });
  const byId = new Map(results.map((r) => [r.row.id, r]));
  const differ = [];
  const none = [];
  for (const row of rows) {
    const got = byId.get(row.id);
    if (!got || got.place === null) { none.push(row); continue; }
    if (got.place !== row.expect) differ.push({ row, got });
  }
  const show = (d) => `${d.row.id} ${JSON.stringify(d.row.command)}${d.row.retry ? " [retry]" : ""}: expected ${d.row.expect}, the binary ran it ${d.got.place} (${d.got.marks.map((m) => `${m.name}=${m.sandboxed ? 1 : 0}`).join(" ")})`;
  t.diagnostic(`Claude Code ${claudeInfo().version}: ${rows.length - differ.length - none.length} of ${rows.length} rows gave the recorded answer; ${none.length} did not run anything`);
  for (const d of differ) t.diagnostic(`  differs: ${show(d)}`);
  for (const r of none) { const g = byId.get(r.id); t.diagnostic(`  ran nothing: ${r.id} ${JSON.stringify(r.command)} (${g ? `called=${g.called} text=${JSON.stringify(String(g.text).slice(0, 120))} decision=${JSON.stringify(g.decision)} session=${JSON.stringify(g.session)}` : "no result"})`); }
  assert.equal(none.length, 0, `${none.length} rows ran nothing: the stand-in programs left no mark`);
  if (known) assert.deepEqual(differ.map(show), []);
  else {
    assert.deepEqual(differ.filter((d) => d.row.core).map(show), [], "the core rows");
    assert.ok(differ.length / rows.length <= 0.05, `${differ.length} of ${rows.length} rows differ on Claude Code ${version}`);
  }
});

test("who approves the call (permission mode default, no allow rule for Bash): the approval table put to the binary", { skip: SKIP, timeout: 1200000 }, async (t) => {
  const results = await runGroups(approvalGroups(), { limit: process.platform === "darwin" ? 3 : 4, approval: true });
  const byId = new Map(results.map((r) => [r.row.id, r]));
  const differ = [];
  for (const row of approvals) {
    const got = byId.get(row.id);
    const seen = got ? approvalOf(got) : "no result";
    if (seen !== row.expect) differ.push(`${row.id} ${JSON.stringify(row.command)}: expected ${row.expect}, the binary did ${seen} (${got ? JSON.stringify(String(got.text).slice(0, 140)) : ""} decision=${got ? JSON.stringify(got.decision) : ""})`);
  }
  t.diagnostic(`Claude Code ${claudeInfo().version}: ${approvals.length - differ.length} of ${approvals.length} approval rows gave the recorded answer`);
  for (const d of differ) t.diagnostic(`  differs: ${d}`);
  assert.deepEqual(differ, []);
});
