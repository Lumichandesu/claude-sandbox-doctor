// A stand-in for the claude binary, for the tests of `check --live`: it prints what `claude -p --output-format stream-json
// --verbose` prints for the three probes of src/live.mjs, in the way each situation would end them. The situation comes from the
// environment variable FAKE_CLAUDE (a name below). It never talks to the fake API and never runs a command, except that the
// situation "outside" creates the file that the write probe asks for, as an unsandboxed command would.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("9.9.9 (Claude Code)\n"); process.exit(0); }

const situation = process.env.FAKE_CLAUDE || "healthy";
const result = (id, text, { error = false, decision = "accept" } = {}) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_probe_${id}`, content: text, ...(error ? { is_error: true } : {}) }] }, tool_result_meta: [{ id: `toolu_probe_${id}`, permission_decision: { decision } }] });
const out = [];
const done = (extra = {}) => out.push({ type: "result", subtype: "success", is_error: false, permission_denials: [], ...extra });
let stderr = "";
let exit = 0;

switch (situation) {
  case "healthy":
    out.push(result(0, "1\n"));
    out.push(result(1, "Exit code 1\ntouch: cannot touch '/x': Read-only file system", { error: true }));
    out.push(result(2, "403\n<sandbox_violations>\ndeny network-outbound sandbox-doctor-probe.invalid:80 (user denied)\n</sandbox_violations>"));
    done();
    break;
  case "outside": {
    // no sandbox, and an allow rule for everything: the command ran outside, and the file was written
    const home = process.env.HOME || process.env.USERPROFILE;
    fs.writeFileSync(path.join(home, "sandbox-doctor-write-probe"), "");
    out.push(result(0, "Exit code 1", { error: true }));
    out.push(result(1, ""));
    out.push(result(2, "000"));
    done();
    break;
  }
  case "unavailable":
    // the sandbox could not start and failIfUnavailable is off: only the call that an allow rule covers ran
    stderr = "⚠ Sandbox disabled: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed, socat not installed\n  Commands will run WITHOUT sandboxing.\n";
    out.push(result(0, "Exit code 1", { error: true }));
    out.push(result(1, "Claude requested permissions to use Bash, but you haven't granted it yet.", { error: true, decision: "reject" }));
    out.push(result(2, "Claude requested permissions to use Bash, but you haven't granted it yet.", { error: true, decision: "reject" }));
    done({ permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_probe_1" }, { tool_name: "Bash", tool_use_id: "toolu_probe_2" }] });
    break;
  case "broken":
    for (let i = 0; i < 3; i++) out.push(result(i, "Exit code 1\nbwrap: loopback: Failed RTM_NEWADDR: Operation not permitted", { error: true }));
    done();
    break;
  case "refuses":
    stderr = "Error: sandbox required but unavailable: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed\n";
    out.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Sandbox required but unavailable: dependencies are missing"], permission_denials: [] });
    exit = 1;
    break;
  case "silent":
    break;
  default:
    process.stderr.write(`unknown situation ${situation}\n`);
    process.exit(3);
}
for (const e of out) process.stdout.write(`${JSON.stringify(e)}\n`);
if (stderr) process.stderr.write(stderr);
process.exit(exit);
