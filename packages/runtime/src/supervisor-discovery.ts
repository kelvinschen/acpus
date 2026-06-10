/**
 * Supervisor discovery and lazy ensure.
 *
 * `ensureWorkspaceSupervisor()` is the single entry point for CLI commands
 * that need a running supervisor. It reads metadata, health-checks an existing
 * supervisor, and spawns a new one if none is alive — with a lock to
 * serialize concurrent ensure calls.
 */

import type { SupervisorMetadata } from "./types.js";
import {
  readFileSync,
  rmSync,
  existsSync,
  openSync,
  closeSync,
  mkdirSync
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireSupervisorLock } from "./supervisor-lock.js";

const SUPERVISOR_METADATA_FILE = "supervisor.json";

/**
 * Ensure a Run Supervisor is running for the given workspace.
 * Returns its metadata on success, throws on failure.
 */
export async function ensureWorkspaceSupervisor(
  workspace: string,
  options?: { idleTimeoutMs?: number }
): Promise<SupervisorMetadata> {
  const absWorkspace = resolve(workspace);
  const stateDir = join(absWorkspace, ".acpus", "state");
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
  const release = await acquireSupervisorLock(stateDir);

  // 3. Re-check metadata (another process may have started supervisor while we waited)
  try {
    const afterLock = tryReadMetadata(metadataPath);
    if (afterLock) {
      const validated = await validateExistingSupervisor(afterLock, absWorkspace);
      if (validated) {
        await release();
        return validated;
      }
      try { rmSync(metadataPath); } catch { /* ignore */ }
    }

    // 4. Spawn supervisor
    const metadata = await spawnSupervisor(absWorkspace, stateDir, options?.idleTimeoutMs);
    return metadata;
  } finally {
    await release();
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

async function spawnSupervisor(
  workspace: string,
  stateDir: string,
  idleTimeoutMs?: number
): Promise<SupervisorMetadata> {
  const metadataPath = join(stateDir, SUPERVISOR_METADATA_FILE);

  // Resolve entry script path and command
  const entry = resolveEntryPath();

  const args = [...entry.args, "--state-dir", stateDir, "--workspace", workspace];
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

  const child = spawn(entry.cmd, args, {
    detached: true,
    stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
    env: buildSupervisorEnv()
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

export function buildSupervisorEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
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
