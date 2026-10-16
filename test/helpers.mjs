// Shared test helpers: throwaway worlds (a Claude config folder, a home folder, project folders) and ways to run the CLI.
//
// SAFETY: nothing here reads or writes the real Claude folder or the real ~/.claude.json. Importing this file points HOME,
// USERPROFILE, CLAUDE_CONFIG_DIR and the managed-settings folder of the test process at an empty temporary folder, so even a
// test that forgets to pass its own environment cannot reach them. Every child process gets a world's environment, and
// runCli refuses to run with a config or home folder outside the OS temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "bin", "claude-sandbox-doctor.mjs");
export const NOW = Date.parse("2026-10-16T12:00:00.000Z");

const made = [];
export function tmpDir(prefix = "csd-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ } } });

// The guard: an empty home, config folder and managed folder for this process.
const guard = tmpDir("csd-guard-");
process.env.HOME = guard;
process.env.USERPROFILE = guard;
process.env.CLAUDE_CONFIG_DIR = path.join(guard, ".claude");
process.env.CLAUDE_SANDBOX_DOCTOR_MANAGED_DIR = path.join(guard, "no-managed-settings");
process.env.NO_COLOR = "1";
for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|ANTHROPIC_)/.test(k)) delete process.env[k];
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDECODE;

const underTmp = (p) => path.resolve(p).toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase());
const configDirOf = (e) => e.CLAUDE_CONFIG_DIR || path.join((process.platform === "win32" ? e.USERPROFILE || e.HOME : e.HOME) || "", ".claude");

const asText = (v) => (typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`);
export const put = (file, v, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, asText(v)); if (mode) fs.chmodSync(file, mode); return file; };
export const fwd = (p) => String(p).split(path.sep).join("/");

/**
 * A throwaway world. base/home/.claude is the config folder (CLAUDE_CONFIG_DIR); base/work/proj is the project folder, and
 * base/managed the managed-settings folder.
 */
export function world(name = "w", { configDir = true } = {}) {
  const base = tmpDir(`csd-${name}-`);
  const home = path.join(base, "home");
  const claude = path.join(home, ".claude");
  const work = path.join(base, "work", "proj");
  const managedDir = path.join(base, "managed");
  for (const d of [claude, work]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", CLAUDE_SANDBOX_DOCTOR_MANAGED_DIR: managedDir };
  if (configDir) env.CLAUDE_CONFIG_DIR = claude; else delete env.CLAUDE_CONFIG_DIR;
  delete env.FORCE_COLOR;
  const w = {
    base, home, claude, work, managedDir, env,
    userFile: path.join(claude, "settings.json"),
    projectFile: path.join(work, ".claude", "settings.json"),
    localFile: path.join(work, ".claude", "settings.local.json"),
    managedFile: path.join(managedDir, "managed-settings.json"),
    write: (file, v) => put(file, v),
    read: (file) => fs.readFileSync(file, "utf8"),
    exists: (file) => fs.existsSync(file),
    user: (v) => put(w.userFile, v),
    project: (v) => put(w.projectFile, v),
    local: (v) => put(w.localFile, v),
    managed: (v) => put(w.managedFile, v),
  };
  return w;
}

/** Runs the real CLI in a child process. */
export function runCli(args, { cwd, env, input, timeout = 120000 } = {}) {
  const e = { ...process.env, ...env };
  if (!underTmp(configDirOf(e)) || !underTmp(e.HOME || "") || !underTmp(e.USERPROFILE || "")) {
    throw new Error("runCli needs an environment from world(): the Claude config and home folders must be temporary");
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: e, input, encoding: "utf8", windowsHide: true, timeout });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: `${r.stdout || ""}${r.stderr || ""}` };
}

/** Runs main() in this process and captures what it prints. */
export async function run(args, w, { cwd, env = {}, now = NOW, platform, sys, runLive } = {}) {
  let out = "";
  let err = "";
  const code = await main(args, {
    cwd: cwd || w.work,
    env: { ...w.env, ...env },
    home: w.home,
    managed: w.managedDir,
    platform,
    sys,
    runLive,
    now,
    stdout: { write: (s) => { out += s; return true; } },
    stderr: { write: (s) => { err += s; return true; } },
  });
  return { code, out, err, all: out + err, json: () => JSON.parse(out) };
}
