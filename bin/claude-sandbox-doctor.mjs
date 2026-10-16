#!/usr/bin/env node
// claude-sandbox-doctor: whether Claude Code's Bash sandbox works on this machine, and why a command ran inside it, outside it, or not at all.
// All the work lives in src/cli.mjs; run `claude-sandbox-doctor --help` for the commands.
import { main } from "../src/cli.mjs";

// `claude-sandbox-doctor show | head` closes the pipe early: that is not an error.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

process.exitCode = await main(process.argv.slice(2));
