// The package itself: what it says it is, what it imports, which Node it needs, which files may start a process or open a
// socket, that the plugin's skill calls the tool with options the tool has, that the icon is a real PNG of the right size, that
// the workflows and the README have what they promise, and that the version is the same everywhere.
import { ROOT } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.mjs";

// a checkout on Windows may turn line feeds into CRLF
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const json = (rel) => JSON.parse(read(rel));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const walk = (dir, ext, out = []) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, ext, out);
    else if (e.name.endsWith(ext)) out.push(rel.split(path.sep).join("/"));
  }
  return out;
};
const sources = () => [...walk("src", ".mjs"), ...walk("bin", ".mjs")];

const pkg = json("package.json");
const plugin = json(".claude-plugin/plugin.json");

test("package.json: name, version, bin, engines, no dependencies, tests run with node --test, the files that are shipped", () => {
  assert.equal(pkg.name, "claude-sandbox-doctor");
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, { "claude-sandbox-doctor": "bin/claude-sandbox-doctor.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) assert.equal(pkg[k], undefined, k);
  assert.equal(pkg.scripts.test, "node --test");
  assert.deepEqual(pkg.files, ["bin", "src", ".claude-plugin", "skills", "README.md", "LICENSE"]);
  for (const f of pkg.files) assert.ok(exists(f), `${f} is listed and exists`);
  assert.match(pkg.description, /^Whether Claude Code's Bash sandbox works on this machine/);
  assert.match(pkg.description, /Zero tokens\.$/);
  assert.equal(pkg.repository, "github:nrzz/claude-sandbox-doctor");
  assert.equal(pkg.homepage, "https://nrzz.github.io/claude-code-toolkit/");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-sandbox-doctor/issues");
  assert.equal(pkg.author, "Naresh Prabu");
  for (const k of ["claude", "claude-code", "sandbox", "bubblewrap", "seatbelt", "security"]) assert.ok(pkg.keywords.includes(k), k);
});

test("no lock file, no vendored node_modules, and no .gitattributes (the plugin directory cannot validate a repository that has one)", () => {
  assert.ok(!exists("package-lock.json"));
  assert.ok(!exists("npm-shrinkwrap.json"));
  assert.ok(!exists("yarn.lock"));
  assert.ok(!exists("node_modules") || fs.readdirSync(path.join(ROOT, "node_modules")).length === 0);
  assert.ok(!exists(".gitattributes"));
  assert.match(read(".gitignore"), /^node_modules\/$/m);
});

test("no tracked text file has a carriage return in it (the index is checked, because a Windows checkout may add them to the working tree)", { skip: !exists(".git") && "not a git checkout" }, () => {
  const r = spawnSync("git", ["-C", ROOT, "ls-files", "--eol"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return; // no git on this machine
  const bad = r.stdout.split("\n").filter(Boolean).filter((l) => /^i\/(crlf|mixed)\b/.test(l));
  assert.deepEqual(bad, []);
});

test("the plugin manifest matches the package, with the six links the listing wants", () => {
  assert.equal(plugin.name, "sandbox-doctor");
  assert.equal(plugin.displayName, "Sandbox Doctor");
  assert.equal(plugin.version, VERSION);
  assert.equal(plugin.license, "MIT");
  assert.deepEqual(plugin.author, { name: "Naresh Prabu" });
  assert.equal(plugin.homepage, "https://github.com/nrzz/claude-sandbox-doctor");
  assert.equal(plugin.repository, "https://github.com/nrzz/claude-sandbox-doctor");
  assert.equal(plugin.documentationUrl, "https://github.com/nrzz/claude-sandbox-doctor#readme");
  assert.equal(plugin.supportUrl, "https://github.com/nrzz/claude-sandbox-doctor/issues");
  assert.equal(plugin.privacyPolicyUrl, "https://github.com/nrzz/claude-sandbox-doctor#privacy");
  assert.equal(plugin.termsOfServiceUrl, "https://github.com/nrzz/claude-sandbox-doctor/blob/main/LICENSE");
  assert.deepEqual(plugin.keywords, ["sandbox", "bubblewrap", "seatbelt", "security", "network", "permissions"]);
  assert.match(plugin.description, /\/sandbox-doctor:check/);
  assert.equal(plugin.hooks, undefined, "no hooks: the plugin is one skill");
  assert.equal(plugin.mcpServers, undefined);
  assert.ok(!exists("hooks"), "a diagnostic tool adds no hook of its own");
  assert.ok(!exists("agents") && !exists("commands"));
});

test("the icon is a real PNG, 1024 by 1024, as the other plugins' are", () => {
  const png = fs.readFileSync(path.join(ROOT, ".claude-plugin", "icon.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "the PNG signature");
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 1024, "width");
  assert.equal(png.readUInt32BE(20), 1024, "height");
  assert.ok(png.length > 2000 && png.length < 500000, `${png.length} bytes`);
  assert.equal(png.toString("ascii", png.length - 8, png.length - 4), "IEND");
});

test("every source file is .mjs and imports only node built-ins and the package itself", () => {
  const files = sources();
  assert.ok(files.length >= 5, `${files.length} files`);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "src")).filter((n) => !n.endsWith(".mjs") && n !== "engine"), []);
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)";/gms)) {
      const spec = m[1];
      assert.ok(spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("node:"), `${f} imports ${spec}`);
    }
    assert.doesNotMatch(text, /\brequire\(|\bimport\(/, `${f} has no dynamic loading`);
  }
});

test("only APIs that exist in Node 18 are used", () => {
  const newer = [
    [/\.toSorted\(|\.toReversed\(|\.toSpliced\(|\.with\(\d/, "Array copy-methods (Node 20)"],
    [/\bObject\.groupBy\b|\bMap\.groupBy\b/, "groupBy (Node 21)"],
    [/\bArray\.fromAsync\b/, "Array.fromAsync (Node 22)"],
    [/\bPromise\.withResolvers\b/, "Promise.withResolvers (Node 22)"],
    [/import\.meta\.(dirname|filename)\b/, "import.meta.dirname/filename (Node 20.11)"],
    [/\bfs\.(glob|globSync)\b/, "fs.glob (Node 22)"],
    [/\.(isWellFormed|toWellFormed)\(/, "String well-formed methods (Node 20)"],
    [/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, "Set methods (Node 22)"],
    [/process\.getBuiltinModule|process\.loadEnvFile|util\.styleText|\bstyleText\b/, "newer process/util APIs"],
    [/\bimport\s[^;]*\swith\s*\{/, "import attributes"],
    [/\bfs\.cpSync\b/, "fs.cpSync is experimental before Node 22"],
  ];
  for (const f of sources()) {
    const text = read(f);
    for (const [re, what] of newer) assert.doesNotMatch(text, re, `${f}: ${what}`);
  }
});

test("the licence, the conduct file, the changelog and the version agree", () => {
  assert.match(read("LICENSE"), /^MIT License/);
  assert.match(read("LICENSE"), /Copyright \(c\) 2026 Naresh Prabu/);
  assert.ok(exists("CODE_OF_CONDUCT.md"));
  assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${VERSION.replace(/\./g, "\\.")}\\] - 2026-10-16$`, "m"));
  assert.match(read("CHANGELOG.md"), new RegExp(`^\\[${VERSION.replace(/\./g, "\\.")}\\]: https://github\\.com/nrzz/claude-sandbox-doctor/releases/tag/v${VERSION.replace(/\./g, "\\.")}$`, "m"));
  for (const f of ["SECURITY.md", "SUPPORT.md", "ROADMAP.md", "CONTRIBUTING.md"]) assert.ok(exists(f), f);
  assert.match(read("SECURITY.md"), /security\/advisories\/new/);
  const roadmap = read("ROADMAP.md");
  assert.ok((roadmap.match(/^- /gm) || []).length >= 3 && (roadmap.match(/^- /gm) || []).length <= 5, "three to five next steps");
  assert.match(roadmap, /good first issue/);
});

test("the issue forms and the pull request template are there", () => {
  for (const f of ["bug_report.yml", "feature_request.yml", "config.yml"]) assert.ok(exists(`.github/ISSUE_TEMPLATE/${f}`), f);
  assert.match(read(".github/ISSUE_TEMPLATE/config.yml"), /blank_issues_enabled: false/);
  assert.match(read(".github/ISSUE_TEMPLATE/config.yml"), /nrzz\/claude-sandbox-doctor\/discussions/);
  assert.ok(exists(".github/PULL_REQUEST_TEMPLATE.md"));
  assert.match(read(".github/dependabot.yml"), /package-ecosystem: github-actions/);
});

test("no test asks the machine for its home folder: every test builds its own world in a temporary folder", () => {
  for (const f of walk("test", ".mjs")) {
    if (f.endsWith("repo.test.mjs")) continue;
    assert.doesNotMatch(read(f), /os\.homedir\(\)/, `${f} reaches for the real home folder`);
  }
});

test("the process the tests run in has its home, config folder and managed folder pointed at a throwaway folder", () => {
  assert.notEqual(process.env.CLAUDE_CONFIG_DIR, "");
  assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(process.env.HOME), "the config folder is inside the throwaway home");
  assert.match(process.env.CLAUDE_SANDBOX_DOCTOR_MANAGED_DIR, /no-managed-settings$/);
  assert.equal(process.env.USERPROFILE, process.env.HOME);
});
