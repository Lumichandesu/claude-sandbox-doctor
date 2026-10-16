// The table of domain entries (test/domain-table.mjs) against the lint, with no binary: an entry that `lint` calls dead has no
// request that is let through, and an entry it does not call dead has one. test/e2e-domains.test.mjs puts the same table to the
// real Claude Code.
import test from "node:test";
import assert from "node:assert/strict";
import { groups, requests } from "./domain-table.mjs";
import { domainProblem } from "../src/lint.mjs";

test("the table has more than twenty requests in more than twenty groups, and every group has a request that says something", () => {
  assert.ok(groups.length >= 20, `${groups.length} groups`);
  assert.ok(requests.length >= 40, `${requests.length} requests`);
  for (const g of groups) assert.ok(g.requests.length >= 1, g.label);
  assert.equal(new Set(requests.map((r) => r.id)).size, requests.length, "ids are unique");
});

test("an entry that lint calls dead has no request that is let through; every other entry of the table can match a host", () => {
  for (const g of groups) {
    const problems = g.allow.map((e) => domainProblem(e));
    const dead = problems.map((p) => (p ? p.code : null));
    if (g.lint) {
      assert.deepEqual(dead, g.allow.map(() => g.lint), `${g.label}: the code lint gives`);
      for (const r of g.requests) assert.equal(r.allowed, false, `${g.label}: ${r.request} cannot be let through by a dead entry`);
    } else {
      assert.deepEqual(dead, g.allow.map(() => null), `${g.label}: lint finds nothing wrong with the entries`);
      assert.ok(g.requests.some((r) => r.allowed), `${g.label}: a live entry lets something through`);
    }
  }
});

test("every dead spelling that lint knows has a group in the table", () => {
  const codes = new Set(groups.map((g) => g.lint).filter(Boolean));
  for (const code of ["domain-scheme", "domain-path", "domain-port", "domain-wildcard", "domain-space", "domain-empty", "domain-chars"]) assert.ok(codes.has(code), code);
});
