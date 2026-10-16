// network.allowedDomains and deniedDomains put to the real Claude Code: which spellings of an entry let a request through the
// sandbox's proxy and which never match (the table of test/domain-table.mjs). Runs where the sandbox exists (Linux with
// bubblewrap and socat, macOS), at zero tokens: the hosts are under .invalid, which never resolves, so a request that the proxy
// lets through ends in a failed lookup, and one it refuses ends in its 403 and a line "deny network-outbound host:port". The
// permission mode is default: in bypassPermissions Claude Code lets every host through (test/e2e-sandbox.test.mjs shows that).
import test from "node:test";
import assert from "node:assert/strict";
import { claudeInfo, fakeApi, put, runClaude, sandbox, skip, streamEvents, toolCalls, IS_WIN } from "./claude-sandbox.mjs";
import { groups, requests } from "./domain-table.mjs";

const SKIP = skip() || (IS_WIN && "the Bash sandbox exists on Linux, WSL2 and macOS only");
const curl = (host, port) => `curl -sS -m 10 -o /dev/null -w "%{http_code}" http://${host}${port === 80 ? "" : `:${port}`}/`;

/** Whether the proxy refused the request, from the tool result: its 403, or the violation line that names the host and port. */
export function refused(text, host, port) {
  return /(^|\n)403\b/.test(text) || text.includes(`network-outbound ${host}:${port}`);
}

async function runGroup(g) {
  const rows = requests.filter((r) => groups[r.group] === g);
  for (let attempt = 0; attempt < 3; attempt++) {
    const sb = sandbox("domains");
    put(sb.user, { sandbox: { enabled: true, network: { allowedDomains: g.allow, ...(g.deny ? { deniedDomains: g.deny } : {}) } } });
    const api = await fakeApi({ calls: rows.map((r) => ({ command: curl(r.host, r.port) })) });
    try {
      const run = await runClaude(sb, api, ["-p", "PROBE-MAIN go", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--max-turns", String(rows.length + 3)]);
      const calls = toolCalls(streamEvents(run));
      if (!calls.length && attempt < 2) continue;
      return rows.map((row, n) => {
        const call = calls.find((c) => c.id === `toolu_call_${n}`);
        return { row, text: call ? call.text : null, refused: call ? refused(call.text, row.host, row.port) : null };
      });
    } finally { await api.close(); }
  }
  return [];
}

test("the table of domain entries put to the binary: which requests the proxy lets through and which it refuses", { skip: SKIP, timeout: 900000 }, async (t) => {
  const out = [];
  let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= groups.length) return; out.push(...await runGroup(groups[i])); } };
  await Promise.all(Array.from({ length: Math.min(process.platform === "darwin" ? 3 : 4, groups.length) }, worker));
  const byId = new Map(out.map((o) => [o.row.id, o]));
  const differ = [];
  const none = [];
  for (const row of requests) {
    const got = byId.get(row.id);
    if (!got || got.refused === null) { none.push(row); continue; }
    if (got.refused === row.allowed) differ.push(`${row.id} entries ${JSON.stringify(row.allow)}${row.deny.length ? ` denied ${JSON.stringify(row.deny)}` : ""} request ${row.request}: expected ${row.allowed ? "let through" : "refused"}, the proxy ${got.refused ? "refused" : "let it through"} (${JSON.stringify(String(got.text).slice(0, 160))})`);
  }
  t.diagnostic(`Claude Code ${claudeInfo().version}: ${requests.length - differ.length - none.length} of ${requests.length} requests were let through or refused as the table says; ${none.length} did not run`);
  for (const d of differ) t.diagnostic(`  differs: ${d}`);
  for (const r of none) t.diagnostic(`  did not run: ${r.id} ${r.request}`);
  const sample = out.find((o) => !o.refused && o.text);
  if (sample) t.diagnostic(`a request that was let through: ${JSON.stringify(sample.text.slice(0, 200))}`);
  const denied = out.find((o) => o.refused && o.text);
  if (denied) t.diagnostic(`a request that was refused: ${JSON.stringify(denied.text.slice(0, 260))}`);
  assert.deepEqual(none.map((r) => r.id), [], "every request ran");
  assert.deepEqual(differ, []);
});
