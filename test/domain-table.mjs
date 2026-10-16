// The table behind two tests:
//
//   test/domain-table.test.mjs  no binary needed: an entry that `lint` calls dead (domainProblem) must have no row that is allowed,
//                               and an entry it does not call dead must have at least one;
//   test/e2e-domains.test.mjs   with E2E_CLAUDE set, on Linux with bubblewrap and on macOS: a request to each host through the
//                               sandbox's proxy must be allowed or refused as the row says.
//
// A group is one set of settings (`allow` is network.allowedDomains, `deny` network.deniedDomains) and the requests made under it.
// A request is "host" or "host:port" (the port is the one in the URL; http is port 80, https 443), and `allowed` says whether the
// proxy lets it through. A host is a name under .invalid, which never resolves, so a request that is let through ends in a failed
// lookup and a request that is refused ends in the proxy's 403 and a line "deny network-outbound host:port" in the tool result.
// `lint` is the code `domainProblem` gives for the entry, or null when the entry can match a host.
// Every row was run against Claude Code in CI on Linux and on macOS (README: What was verified, and how).

export const groups = [];

const group = (label, allow, requests, { deny, lint = null } = {}) => groups.push({ label, allow, ...(deny ? { deny } : {}), lint, requests });
const yes = (r) => ({ request: r, allowed: true });
const no = (r) => ({ request: r, allowed: false });

// ---- spellings that work -----------------------------------------------------------------------------------------------------
group("a host name", ["a.invalid"], [yes("a.invalid"), yes("a.invalid:8080"), no("b.a.invalid"), no("xa.invalid"), no("invalid")]);
group("the case of a name", ["A.Invalid"], [yes("a.invalid")]);
group("a wildcard", ["*.a.invalid"], [yes("b.a.invalid"), yes("c.b.a.invalid"), no("a.invalid"), no("xa.invalid")]);
group("a bare wildcard", ["*"], [yes("a.invalid"), yes("b.c.invalid:8080")]);
group("a port", ["a.invalid:8080"], [yes("a.invalid:8080"), no("a.invalid"), no("a.invalid:9090")]);
group("a wildcard with a port", ["*.a.invalid:8080"], [yes("b.a.invalid:8080"), no("b.a.invalid"), no("b.a.invalid:9090")]);
group("two entries", ["a.invalid", "*.b.invalid"], [yes("a.invalid"), yes("x.b.invalid"), no("b.invalid"), no("c.invalid")]);

// ---- spellings that never match ------------------------------------------------------------------------------------------------
group("a scheme", ["http://a.invalid"], [no("a.invalid"), no("a.invalid:8080")], { lint: "domain-scheme" });
group("a path", ["a.invalid/index.html"], [no("a.invalid")], { lint: "domain-path" });
group("a user name", ["user@a.invalid"], [no("a.invalid")], { lint: "domain-path" });
group("a port with a leading zero", ["a.invalid:080"], [no("a.invalid")], { lint: "domain-port" });
group("port 0", ["a.invalid:0"], [no("a.invalid")], { lint: "domain-port" });
group("a port above 65535", ["a.invalid:65536"], [no("a.invalid")], { lint: "domain-port" });
group("a star inside a name", ["a.*.invalid"], [no("a.x.invalid"), no("a.invalid")], { lint: "domain-wildcard" });
group("a star that is not a whole label", ["*a.invalid"], [no("xa.invalid"), no("a.invalid")], { lint: "domain-wildcard" });
group("a space before the name", [" a.invalid"], [no("a.invalid")], { lint: "domain-space" });
group("a space after the name", ["a.invalid "], [no("a.invalid")], { lint: "domain-space" });
group("an empty entry", [""], [no("a.invalid")], { lint: "domain-empty" });
group("a character a host name does not have", ["a_b!.invalid"], [no("a.invalid")], { lint: "domain-chars" });

// ---- deniedDomains -------------------------------------------------------------------------------------------------------------
group("a denied host inside an allowed wildcard", ["*.a.invalid"], [yes("c.a.invalid"), no("b.a.invalid")], { deny: ["b.a.invalid"] });
group("a denied wildcard under an allowed star", ["*"], [yes("b.invalid"), no("x.a.invalid"), no("y.z.a.invalid")], { deny: ["*.a.invalid"] });

/** The requests of the table with their group: [{ id, group, label, allow, deny, request, host, port, allowed }]. */
export const requests = [];
groups.forEach((g, gi) => g.requests.forEach((r, ri) => {
  const [host, port] = r.request.split(":");
  requests.push({ id: `domain-${String(gi + 1).padStart(2, "0")}-${ri + 1}`, group: gi, label: g.label, allow: g.allow, deny: g.deny || [], request: r.request, host, port: port ? Number(port) : 80, allowed: r.allowed });
}));
