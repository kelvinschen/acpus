/**
 * Supervisor lock management using proper-lockfile.
 *
 * Provides a single entry point `acquireSupervisorLock()` that wraps
 * `proper-lockfile.lock()` with the correct configuration for
 * serializing concurrent `ensureWorkspaceSupervisor()` calls.
 *
 * The lock targets the `.acpus` directory (which always exists) and
 * creates a `.acpus/supervisor.lock` directory as the lock marker.
 * This replaces the old file-based lock which had race conditions
 * and inconsistent semantics between CLI and child process.
 */

import lockfile from "proper-lockfile";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const LOCK_NAME = "supervisor.lock";

/**
 * Acquire the supervisor lock for the given state directory.
 *
 * Returns a release callback that must be called when the lock is
 * no longer needed (typically after the supervisor has been spawned
 * and its metadata is confirmed).
 *
 * Configuration:
 * - `stale: 20_000` — locks older than 20s are considered stale
 *   (max spawn time is ~15s, giving 5s margin)
 * - `update: 2_000` — mtime updated every 2s while lock is held
 * - `retries: 30 × 500ms` — total wait up to 15s for competing processes
 * - `onCompromised: 'warn'` — log but don't throw if lock is tampered
 *
 * Migration: if `.acpus/supervisor.lock` exists as a plain file
 * (legacy format), it is automatically deleted before acquiring.
 */
export async function acquireSupervisorLock(
  stateDir: string
): Promise<() => Promise<void>> {
  // Ensure state directory exists
  mkdirSync(stateDir, { recursive: true });

  const lockPath = join(stateDir, LOCK_NAME);

  // Migration: remove old file-based lock if it exists
  try {
    const stat = statSync(lockPath);
    if (stat.isFile()) {
      rmSync(lockPath);
    }
  } catch {
    // Doesn't exist or can't stat — that's fine
  }

  const release = await lockfile.lock(stateDir, {
    stale: 20_000,
    update: 2_000,
    retries: {
      retries: 30,
      minTimeout: 500,
      maxTimeout: 500,
    },
    // lockfilePath must be an absolute path pointing inside the locked directory
    lockfilePath: lockPath,
    onCompromised: (err) => {
      console.warn(`Supervisor lock compromised: ${err.message}`);
    },
  });

  return release;
}
