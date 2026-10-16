// A managed-settings.json in the system folder, for the checks that put managed settings to the real Claude Code. Claude Code reads
// it from a folder only an administrator can write, and has no setting for another place, so these checks write it with sudo, and
// only where that is safe: on a GitHub Actions runner (a virtual machine that is thrown away) that lets sudo run without a
// password, with CSD_E2E_MANAGED=1 set by the workflow. Anywhere else canWriteManaged() is false and the checks skip.
//
//   Linux and WSL2  /etc/claude-code/managed-settings.json
//   macOS           /Library/Application Support/ClaudeCode/managed-settings.json
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const MANAGED_DIR = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";
export const MANAGED_FILE = path.join(MANAGED_DIR, "managed-settings.json");

const sudo = (args, input) => spawnSync("sudo", ["-n", ...args], { input, encoding: "utf8", timeout: 30000 });

let allowed = null;
/** True on a CI runner that was told to (CSD_E2E_MANAGED=1) and lets sudo run without a password. */
export function canWriteManaged() {
  if (allowed === null) allowed = process.env.CSD_E2E_MANAGED === "1" && process.env.GITHUB_ACTIONS === "true" && (process.platform === "linux" || process.platform === "darwin") && sudo(["true"]).status === 0;
  return allowed;
}
/** The value for node:test's `skip` option: false when the check can write the file, else the reason. */
export const skipManaged = () => (canWriteManaged() ? false : "managed settings are written to the system folder only on a CI runner with CSD_E2E_MANAGED=1 and passwordless sudo");

/** Write managed-settings.json (an object, or text); returns when the file is there. */
export function setManaged(value) {
  if (!canWriteManaged()) throw new Error("setManaged: not allowed here");
  const made = !fs.existsSync(MANAGED_DIR);
  if (made) sudo(["mkdir", "-p", MANAGED_DIR]);
  const w = sudo(["tee", MANAGED_FILE], typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  if (w.status !== 0) throw new Error(`could not write ${MANAGED_FILE}: ${w.stderr}`);
  if (!fs.existsSync(MANAGED_FILE)) throw new Error(`${MANAGED_FILE} is not there after tee`);
}

/** Remove the file, and the folder when it is empty. */
export function clearManaged() {
  if (!canWriteManaged()) return;
  sudo(["rm", "-f", MANAGED_FILE]);
  sudo(["rmdir", MANAGED_DIR]);
}
