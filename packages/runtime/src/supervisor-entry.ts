/**
 * Supervisor entry point — minimal CLI for spawning as a child process.
 *
 * This is the target of `ensureWorkspaceSupervisor()`. It accepts only
 * --state-dir (required) and --idle-timeout (optional), then starts
 * the Run Supervisor and blocks until shutdown.
 *
 * No Commander, no argument parsing beyond these two flags.
 */

import { resolve, join } from "node:path";
import { openSync } from "node:fs";
import { startRunSupervisor } from "./supervisor-runner.js";

function parseArgs(args: string[]): { stateDir: string; idleTimeoutMs?: number } {
  let stateDir: string | undefined;
  let idleTimeoutMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--state-dir" && args[i + 1]) {
      stateDir = args[++i];
    } else if (args[i] === "--idle-timeout" && args[i + 1]) {
      idleTimeoutMs = parseInt(args[++i], 10);
    }
  }

  if (!stateDir) {
    console.error("--state-dir is required");
    process.exit(1);
  }

  return { stateDir: resolve(stateDir), idleTimeoutMs };
}

// Redirect stdout/stderr to supervisor.log
const logPath = join(resolve(parseArgs(process.argv.slice(2)).stateDir), "supervisor.log");
const logFd = openSync(logPath, "a");

const { stateDir, idleTimeoutMs } = parseArgs(process.argv.slice(2));

startRunSupervisor({
  stateDir,
  idleTimeoutMs
}).catch((err) => {
  console.error("Supervisor failed to start:", err);
  process.exit(1);
});
