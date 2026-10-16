// The command line (a first version; the commands arrive with the next commits).
import { VERSION } from "./version.mjs";

const HELP = `claude-sandbox-doctor ${VERSION}
Whether Claude Code's Bash sandbox works on this machine, and why a command ran inside it, outside it, or not at all.

Usage: claude-sandbox-doctor <command> [options]

Options for every command:
  -h, --help     this text
  -v, --version  the version
`;

export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  if (argv.includes("-v") || argv.includes("--version")) { stdout.write(`${VERSION}\n`); return 0; }
  stdout.write(HELP);
  return argv.includes("-h") || argv.includes("--help") ? 0 : 2;
}
