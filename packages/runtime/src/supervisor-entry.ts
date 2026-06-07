/**
 * Supervisor entry point — minimal CLI for spawning as a child process.
 *
 * This is the target of `ensureWorkspaceSupervisor()`. It accepts only
 * --workspace (required) and --idle-timeout (optional), then starts
 * the Run Supervisor and blocks until shutdown.
 *
 * No Commander, no argument parsing beyond these two flags.
 */

import { resolve, join } from "node:path";
import { openSync } from "node:fs";
import { startRunSupervisor } from "./supervisor-runner.js";

function parseArgs(args: string[]): { workspace: string; idleTimeoutMs?: number } {
  let workspace: string | undefined;
  let idleTimeoutMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) {
      workspace = args[++i];
    } else if (args[i] === "--idle-timeout" && args[i + 1]) {
      idleTimeoutMs = parseInt(args[++i], 10);
    }
  }

  if (!workspace) {
    console.error("--workspace is required");
    process.exit(1);
  }

  return { workspace: resolve(workspace), idleTimeoutMs };
}

// Redirect stdout/stderr to supervisor.log
const logPath = join(resolve(parseArgs(process.argv.slice(2)).workspace), ".acpus", "supervisor.log");
const logFd = openSync(logPath, "a");

const { workspace, idleTimeoutMs } = parseArgs(process.argv.slice(2));

startRunSupervisor({
  stateDir: join(workspace, ".acpus"),
  idleTimeoutMs
}).catch((err) => {
  console.error("Supervisor failed to start:", err);
  process.exit(1);
});
