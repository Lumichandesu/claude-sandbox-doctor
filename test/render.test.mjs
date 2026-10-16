// The reports as text: what is hidden in them, and the short forms the skill hands to Claude.
import test from "node:test";
import assert from "node:assert/strict";
import { hideSecrets, markdownCheck } from "../src/render.mjs";
import { run, world } from "./helpers.mjs";
import { ubuntu } from "./fakesys.mjs";

test("hideSecrets: the value of a NAME=value whose name looks like a credential, a Bearer value and the common token shapes", () => {
  assert.equal(hideSecrets("AWS_SECRET_ACCESS_KEY=abc123 aws s3 ls"), "AWS_SECRET_ACCESS_KEY=<hidden> aws s3 ls");
  assert.equal(hideSecrets('GITHUB_TOKEN="a b c" gh pr list'), "GITHUB_TOKEN=<hidden> gh pr list");
  assert.equal(hideSecrets("db_password=hunter2 && x"), "db_password=<hidden> && x");
  assert.equal(hideSecrets("curl -H 'Authorization: Bearer abcdefghijkl' x"), "curl -H 'Authorization: Bearer <hidden>' x");
  assert.equal(hideSecrets("key sk-ant-api03-abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP"), "key <hidden> and <hidden> and <hidden>");
  // not a credential: a plain assignment, a name that only contains the letters of a word
  assert.equal(hideSecrets("NODE_ENV=production npm test"), "NODE_ENV=production npm test");
  assert.equal(hideSecrets("MONKEY=1 run"), "MONKEY=<hidden> run", "a name that ends in KEY is hidden, even if it is a monkey");
  assert.equal(hideSecrets("docker ps"), "docker ps");
});

test("the text reports and the markdown reports hide a credential in a quoted entry; --json keeps it, as data", async () => {
  const w = world("secrets");
  w.user({ sandbox: { enabled: true, excludedCommands: ["API_TOKEN=s3cr3tvalue mytool *", "NODE_ENV=production npm test"] } });
  const sys = ubuntu({ profile: true });
  for (const args of [["lint"], ["lint", "--markdown"], ["show"]]) {
    const r = await run(args, w, { sys });
    assert.doesNotMatch(r.out, /s3cr3tvalue/, args.join(" "));
    assert.match(r.out, /API_TOKEN=<hidden>/, args.join(" "));
  }
  const why = await run(["why", "API_TOKEN=s3cr3tvalue mytool run"], w, { sys });
  assert.doesNotMatch(why.out, /s3cr3tvalue/);
  const json = await run(["lint", "--json"], w, { sys });
  assert.match(json.out, /s3cr3tvalue/, "the JSON document is data: the entry as it is written");
});

test("markdownCheck: the heading and the summary always stay, and no more than seven items between them", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, status: i === 11 ? "fail" : "ok", title: `item ${i}`, fix: "do it" }));
  const lines = markdownCheck({ platform: { label: "Linux" }, items: [{ id: "p", status: "info", title: "platform" }, ...items], summary: "The sandbox can start." }).trimEnd().split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines[0], "## sandbox-doctor check: Linux");
  assert.equal(lines.at(-1), "The sandbox can start.");
  assert.ok(!lines.some((l) => /platform/.test(l)), "an info item is left out");
});
