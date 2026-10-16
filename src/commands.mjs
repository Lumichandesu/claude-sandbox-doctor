// The commands as plain objects: check, show, why, lint. src/render.mjs prints them; --json prints them as they are. Nothing here
// prints and nothing changes a file.
import os from "node:os";
import { checkHost, realSys, detectPlatform } from "./host.mjs";
import { findClaude, runLive } from "./live.mjs";
import { configDir, loadSettings, shortPath } from "./settings.mjs";
import { mergeSandbox } from "./sandbox.mjs";
import { lintSettings } from "./lint.mjs";
import { whyCommand } from "./why.mjs";

const base = (o) => ({ env: o.env || process.env, home: o.home || os.homedir(), platform: o.platform || process.platform, managed: o.managed });

/** The machine as the commands ask for it: the real one, or a play-acting one the tests pass in. */
export function machine(o) {
  return o.sys || realSys(o.env || process.env);
}

export function settingsFor(o) {
  return loadSettings({ project: o.project, ...base(o) });
}

export async function buildCheckModel(o) {
  const sys = machine(o);
  let settings = null;
  let merged = null;
  const paths = {};
  try {
    settings = settingsFor({ ...o, project: o.project });
    merged = mergeSandbox(settings, { platform: detectPlatform(sys).id });
    const v = (k) => (merged.values[k] && merged.values[k].winner ? merged.values[k].winner.value : undefined);
    if (typeof v("bwrapPath") === "string") paths.bwrapPath = v("bwrapPath");
    if (typeof v("socatPath") === "string") paths.socatPath = v("socatPath");
    paths.enableWeakerNestedSandbox = v("enableWeakerNestedSandbox") === true;
  } catch { /* the settings are not needed for the host checks */ }
  const host = checkHost(sys, { settings: paths });
  const model = { ok: host.ok, platform: host.platform, hasSandbox: host.hasSandbox, items: host.items, missing: host.missing, summary: host.summary, live: null };
  if (o.live) {
    if (!host.hasSandbox) model.live = { skipped: true, reason: `there is no Bash sandbox on ${host.platform.label}, so there is nothing to put to Claude Code` };
    else if (!host.ok && host.missing.length) model.live = { skipped: true, reason: `the sandbox cannot start here (missing: ${host.missing.join(", ")}); what Claude Code does then is in the README: it runs commands without a sandbox and says so` };
    else {
      const found = findClaude(o.claude, sys);
      if (found.error) model.live = { skipped: true, reason: found.error };
      else {
        const run = await (o.runLive || runLive)({ claude: found.path, sys });
        model.live = { skipped: false, claude: found.path, ...run };
        if (!run.ok) model.ok = false;
      }
    }
  }
  return model;
}

export function buildShowModel(o) {
  const s = settingsFor(o);
  const host = detectPlatform(machine(o));
  const m = mergeSandbox(s, { platform: host.id });
  return { ok: true, project: s.project, configDir: s.configDir, configSource: configDir(base(o).env, base(o).home).source, platform: host, ...m, notRead: ["server-managed settings, macOS profiles and the Windows registry (only managed-settings.json and managed-settings.d are read)", "the --settings and --setting-sources flags, which a launcher can add (a --settings that forbids the retry makes the sandbox admin-required too)", "hooks and mods, which can decide a call before the sandbox does"] };
}

export function buildWhyModel(o) {
  const s = settingsFor(o);
  const host = detectPlatform(machine(o));
  const r = whyCommand({ command: o.command, settings: s, platform: host.id, retry: Boolean(o.retry) });
  return { ok: true, ...r, project: s.project, configDir: s.configDir, system: host };
}

export function buildLintModel(o) {
  const s = settingsFor(o);
  const sys = machine(o);
  const host = checkHost(sys, { light: true, settings: {} });
  const merged = mergeSandbox(s, { platform: host.platform.id });
  const { findings, counts } = lintSettings(s, { host, merged });
  return { ok: true, project: s.project, configDir: s.configDir, platform: host.platform, hostMissing: host.missing, findings, counts, files: s.files.map((f) => ({ scope: f.scope, label: f.label, path: f.path, display: f.display, exists: f.exists, ignored: f.ignored, sandboxKeys: f.view && f.view.sandbox ? Object.keys(f.view.sandbox.entries).length : 0 })) };
}

export { shortPath };
