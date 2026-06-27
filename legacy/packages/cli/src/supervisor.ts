/**
 * CLI helper: ensure a workspace supervisor is running and return a client.
 *
 * All Run-facing CLI commands call `ensureSupervisor()` to lazily start
 * the supervisor and construct an `RunSupervisorClient`.
 */

import { ensureWorkspaceSupervisor, RunSupervisorClient } from "@acpus/runtime";

export const EXIT_SUPERVISOR_ERROR = 40;

/**
 * Ensure a Run Supervisor is running for the current workspace and
 * return a connected client. Maps discovery errors to exit code 40.
 */
export async function ensureSupervisor(): Promise<RunSupervisorClient> {
  const metadata = await ensureWorkspaceSupervisor(process.cwd());
  return new RunSupervisorClient(metadata.endpoint);
}

/**
 * Check if an error is a supervisor connection error.
 */
export function isSupervisorConnectionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|fetch failed|connect|supervisor|ENOENT|spawn|timed out|failed to start/i.test(msg);
}
