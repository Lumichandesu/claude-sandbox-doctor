// The table of test/why-table.mjs against `why`, with no binary: what `why` says for each row must equal what the real binary did
// (test/e2e-table.test.mjs runs the same rows again against Claude Code, on Linux and macOS).
import test from "node:test";
import assert from "node:assert/strict";
import { approvals, rows, groups } from "./why-table.mjs";
import { firstCode, predict } from "./oracle.mjs";

test("the table has the rows it says: more than a hundred, in every group, each with an answer", () => {
  assert.ok(rows.length >= 100, `${rows.length} rows`);
  const names = new Set(rows.map((r) => r.group));
  for (const g of ["entry", "compound", "redirect", "wrapper", "shape", "git", "flag", "retry-default", "retry-strict", "retry-user-false", "files", "off", "star", "prefix-forms"]) assert.ok(names.has(g), g);
  for (const r of rows) assert.ok(["sandboxed", "unsandboxed"].includes(r.expect), `${r.id}: ${r.expect}`);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "the ids are unique");
  assert.ok(rows.some((r) => r.retry), "some rows retry with dangerouslyDisableSandbox");
  assert.ok(groups().length >= 10, "rows are grouped by their settings, so that one claude session runs many rows");
});

test("every row: why says where the binary ran it, and (when the row names one) for which reason it stayed in", () => {
  const bad = [];
  for (const row of rows) {
    const got = predict(row);
    const place = got.runs;
    if (place !== row.expect) bad.push(`${row.id} ${JSON.stringify(row.command)}: binary ${row.expect}, why ${place} (${got.basis}; ${firstCode(got) || got.reason})`);
    else if (row.expect === "sandboxed" && row.code && !row.retry && firstCode(got) !== row.code) bad.push(`${row.id} ${JSON.stringify(row.command)}: the reason is ${row.code}, why says ${firstCode(got)}`);
  }
  assert.deepEqual(bad, []);
});

test("every approval row: why says whether the call is approved, asked about or denied", () => {
  const bad = [];
  for (const row of approvals) {
    const got = predict(row);
    if (got.approval.outcome !== row.expect) bad.push(`${row.id} ${JSON.stringify(row.command)}: binary ${row.expect}, why ${got.approval.outcome} (${got.approval.text})`);
  }
  assert.deepEqual(bad, []);
  assert.ok(approvals.length >= 20, `${approvals.length} approval rows`);
});
