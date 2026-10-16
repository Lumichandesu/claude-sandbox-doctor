// The plumbing of the real-binary checks, with no binary: they skip, and do not crash, when the binary cannot be run; the marks
// the stand-in programs leave are read the way the oracle needs them.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, put, tmpDir } from "./helpers.mjs";
import { ownMarks, placeOf, readMarks } from "./oracle.mjs";

test("a real-binary check skips, and does not crash, when E2E_CLAUDE names a file that is no program (a failed install leaves one)", () => {
  const dir = tmpDir("csd-nonprogram-");
  const bad = path.join(dir, process.platform === "win32" ? "claude.exe" : "claude");
  put(bad, "this is not a program\n", 0o755);
  const env = { ...process.env, E2E_CLAUDE: bad };
  delete env.NODE_TEST_CONTEXT;
  for (const file of ["e2e-sandbox.test.mjs", "e2e-table.test.mjs", "e2e-nobwrap.test.mjs", "e2e-plugin.test.mjs"]) {
    const r = spawnSync(process.execPath, ["--test", path.join(ROOT, "test", file)], { encoding: "utf8", env, timeout: 120000, windowsHide: true });
    assert.equal(r.status, 0, `${file}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /skipped [1-9]/, file);
    assert.doesNotMatch(r.stdout, /did not run: .*(ENOEXEC|ENOENT)[^\n]*\n[^\n]*not ok/);
  }
});

test("readMarks and placeOf: the lines the stand-ins leave belong to the call that was running, and say where it ran", () => {
  const dir = tmpDir("csd-marks-");
  const file = put(path.join(dir, "marks"), "git 0\n#ROW 0\ndocker 1\n#ROW 1\nmytool 0\nmytool 0\n#ROW 2\nmytool 1\nmytool 0\n#ROW 3\n");
  const marks = readMarks(file);
  assert.deepEqual(Object.keys(marks), ["0", "1", "2", "3"], "the mark before the first row belongs to nothing");
  assert.equal(placeOf(marks[0]), "sandboxed");
  assert.equal(placeOf(marks[1]), "unsandboxed");
  assert.equal(placeOf(marks[2]), "mixed");
  assert.equal(placeOf(marks[3]), null, "a call that ran nothing has no place");
  assert.equal(placeOf(undefined), null);
});

test("ownMarks: a mark of git that Claude Code itself made does not count for a call that does not name git", () => {
  const marks = [{ name: "docker", sandboxed: true }, { name: "git", sandboxed: false }];
  assert.equal(placeOf(ownMarks("time -p docker ps", marks)), "sandboxed");
  assert.equal(placeOf(ownMarks("git status && docker ps", marks)), "mixed");
  assert.equal(placeOf(ownMarks("digit status", marks)), "sandboxed", "digit is not git");
  assert.equal(placeOf(ownMarks("git status", [{ name: "git", sandboxed: false }])), "unsandboxed");
});
