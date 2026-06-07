/**
 * Supervisor discovery and lazy ensure.
 *
 * `ensureWorkspaceSupervisor()` is the single entry point for CLI commands
 * that need a running supervisor. It reads metadata, health-checks an existing
 * supervisor, and spawns a new one if none is alive — with a lock file to
 * serialize concurrent ensure calls.
 */

import type { SupervisorMetadata } from "./types.js";
import {
  readFileSync,
  writeFileSync,
  writeSync,
  rmSync,
  existsSync,
  openSync,
  closeSync,
  renameSync,
  mkdirSync
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SUPERVISOR_METADATA_FILE = "supervisor.json";
const LOCK_FILE = "supervisor.lock";

/**
 * Ensure a Run Supervisor is running for the given workspace.
 * Returns its metadata on success, throws on failure.
 */
export async function ensureWorkspaceSupervisor(
  workspace: string,
  options?: { idleTimeoutMs?: number }
): Promise<SupervisorMetadata> {
  const absWorkspace = resolve(workspace);
  const stateDir = join(absWorkspace, ".acpus");
  const metadataPath = join(stateDir, SUPERVISOR_METADATA_FILE);

  // 1. Try existing metadata
  const existing = tryReadMetadata(metadataPath);
  if (existing) {
    const validated = await validateExistingSupervisor(existing, absWorkspace);
    if (validated) return validated;
    // Stale — clean up
    try { rmSync(metadataPath); } catch { /* ignore */ }
  }

  // 2. Acquire lock
  await acquireLock(stateDir);

  // 3. Re-check metadata (another process may have started supervisor while we waited)
  const afterLock = tryReadMetadata(metadataPath);
  if (afterLock) {
    const validated = await validateExistingSupervisor(afterLock, absWorkspace);
    if (validated) {
      releaseLock(stateDir);
      return validated;
    }
    try { rmSync(metadataPath); } catch { /* ignore */ }
  }

  // 4. Spawn supervisor
  try {
    const metadata = await spawnSupervisor(absWorkspace, stateDir, options?.idleTimeoutMs);
    return metadata;
  } finally {
    releaseLock(stateDir);
  }
}

function tryReadMetadata(path: string): SupervisorMetadata | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as SupervisorMetadata;
  } catch {
    return undefined;
  }
}

async function validateExistingSupervisor(
  meta: SupervisorMetadata,
  expectedWorkspace: string
): Promise<SupervisorMetadata | undefined> {
  // Validate schema version
  if (meta.schemaVersion !== 1) return undefined;

  // Validate workspace matches
  if (resolve(meta.workspace) !== resolve(expectedWorkspace)) return undefined;

  // Validate endpoint is localhost
  if (!meta.endpoint.startsWith("http://127.0.0.1:")) return undefined;

  // Health check
  try {
    const res = await fetch(`${meta.endpoint}/health`);
    if (!res.ok) return undefined;
    const health = await res.json() as { ok?: boolean; pid?: number; endpoint?: string };
    if (!health.ok) return undefined;
    if (health.pid !== meta.pid) return undefined;
    if (health.endpoint !== meta.endpoint) return undefined;
    return meta;
  } catch {
    return undefined;
  }
}

async function acquireLock(stateDir: string): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, LOCK_FILE);
  const maxWaitMs = 10_000;
  const pollIntervalMs = 500;
  const start = Date.now();

  for (;;) {
    // Try atomic create (O_EXCL) — write content via the fd to avoid an
    // empty-file window between closeSync + writeFileSync.
    try {
      const content = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
      const fd = openSync(lockPath, "wx");
      writeSync(fd, content, null, "utf8");
      closeSync(fd);
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
    }

    // Lock file exists — check if the owning PID is alive
    try {
      const raw = readFileSync(lockPath, "utf8");
      const lock = JSON.parse(raw) as { pid: number; timestamp: number };
      if (!isProcessAlive(lock.pid)) {
        // Stale lock — use rename-based atomic replacement to avoid TOCTOU:
        // Create a temp lock with our PID, then rename it over the stale one.
        // rename(2) is atomic on local filesystems.
        const tempLockPath = join(stateDir, LOCK_FILE + ".tmp." + process.pid);
        try {
          const content = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
          const fd = openSync(tempLockPath, "wx");
          writeSync(fd, content, null, "utf8");
          closeSync(fd);
          // Atomically replace the stale lock
          renameSync(tempLockPath, lockPath);
          return;
        } catch {
          // Another process won the race — clean up our temp and retry
          try { rmSync(tempLockPath); } catch { /* ignore */ }
          continue;
        }
      }
    } catch {
      // Corrupt lock file — try atomic replacement the same way
      const tempLockPath = join(stateDir, LOCK_FILE + ".tmp." + process.pid);
      try {
        const content = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
        const fd = openSync(tempLockPath, "wx");
        writeSync(fd, content, null, "utf8");
        closeSync(fd);
        renameSync(tempLockPath, lockPath);
        return;
      } catch {
        try { rmSync(tempLockPath); } catch { /* ignore */ }
        continue;
      }
    }

    // Wait and retry
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`Timed out waiting for supervisor lock at ${lockPath}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

function releaseLock(stateDir: string): void {
  const lockPath = join(stateDir, LOCK_FILE);
  try {
    const raw = readFileSync(lockPath, "utf8");
    const lock = JSON.parse(raw) as { pid: number; timestamp: number };
    // Only delete the lock if we own it (our PID matches)
    if (lock.pid === process.pid) {
      rmSync(lockPath);
    }
  } catch {
    // Lock file missing or corrupt — nothing to release
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks existence without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnSupervisor(
  workspace: string,
  stateDir: string,
  idleTimeoutMs?: number
): Promise<SupervisorMetadata> {
  const metadataPath = join(stateDir, SUPERVISOR_METADATA_FILE);

  // Resolve entry script path and command
  const entry = resolveEntryPath();

  const args = [...entry.args, "--workspace", workspace];
  if (idleTimeoutMs !== undefined) {
    args.push("--idle-timeout", String(idleTimeoutMs));
  }

  // Redirect stdout/stderr to supervisor.log
  const logPath = join(stateDir, "supervisor.log");
  let logFd: number | undefined;
  try {
    logFd = openSync(logPath, "a");
  } catch {
    // If we can't open the log, use 'ignore'
  }

  // Build a filtered environment: pass through everything except known
  // sensitive keys that the supervisor child has no business inheriting.
  const SENSITIVE_PREFIXES = [
    "AWS_", "GCP_", "GOOGLE_", "AZURE_", "VAULT_", "KUBERNETES_",
    "DOCKER_", "SSH_", "GPG_", "PGPASS"
  ];
  const filteredEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_PREFIXES.some((p) => key.startsWith(p))) continue;
    filteredEnv[key] = value;
  }

  const child = spawn(entry.cmd, args, {
    detached: true,
    stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
    env: filteredEnv
  });
  child.unref();

  // Close our copy of the log fd (child inherited it)
  if (logFd !== undefined) {
    try { closeSync(logFd); } catch { /* ignore */ }
  }

  // Wait for supervisor.json to appear (poll every 100ms up to 15s)
  const maxWaitMs = 15_000;
  const start = Date.now();
  try {
    while (Date.now() - start < maxWaitMs) {
      const meta = tryReadMetadata(metadataPath);
      if (meta) {
        // Health check the endpoint
        try {
          const res = await fetch(`${meta.endpoint}/health`);
          if (res.ok) return meta;
        } catch { /* ignore */ }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error(`Supervisor failed to start within ${maxWaitMs / 1000}s`);
  } catch (err) {
    // Kill the orphaned child process if we timed out or failed
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Resolve the entry script path and command for spawning the supervisor.
 * If running via tsx, use tsx to run the TypeScript source.
 * If running as built JS, use node to run the compiled JS.
 */
function resolveEntryPath(): { cmd: string; args: string[] } {
  const runtimeDir = fileURLToPath(new URL(".", import.meta.url));
  const tsEntry = join(runtimeDir, "supervisor-entry.ts");

  // If the TS source exists, we're in development mode (running from source via tsx)
  if (existsSync(tsEntry)) {
    return { cmd: "npx", args: ["tsx", tsEntry] };
  }

  // Production: use the compiled JS
  const jsEntry = join(runtimeDir, "supervisor-entry.js");
  return { cmd: "node", args: [jsEntry] };
}
