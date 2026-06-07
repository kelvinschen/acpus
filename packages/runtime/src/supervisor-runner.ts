import { createSupervisorApp } from "./supervisor-app.js";
import { RunStore } from "./store.js";
import { MockAgentExecutor } from "./executors/mock-agent.js";
import { AgentExecutor } from "./executors/agent.js";
import { ProgramExecutor } from "./executors/program.js";
import type { SupervisorConfig, SupervisorMetadata } from "./types.js";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";

/**
 * Start the acpus Run Supervisor process.
 *
 * Binds to a random port (127.0.0.1:0), writes supervisor.json for discovery,
 * handles graceful shutdown, startup recovery, and idle timeout.
 *
 * Returns the bound metadata so the caller (supervisor-entry) can signal readiness.
 */
export async function startRunSupervisor(config: SupervisorConfig = {}): Promise<SupervisorMetadata> {
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 0; // 0 = random port
  const stateDir = config.stateDir ?? join(process.cwd(), ".acpus");
  const idleTimeoutMs = config.idleTimeoutMs ?? 5 * 60 * 1000; // 5 min default
  const metadataFile = join(stateDir, "supervisor.json");
  const lockFile = join(stateDir, "supervisor.lock");

  // Ensure state directory exists
  mkdirSync(stateDir, { recursive: true });

  // Write lock file atomically — use O_EXCL to avoid overwriting an existing lock
  // held by a concurrent ensureWorkspaceSupervisor() call.
  try {
    const fd = openSync(lockFile, "wx");
    closeSync(fd);
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf8");
  } catch (err: any) {
    if (err.code === "EEXIST") {
      throw new Error(`Supervisor lock file already exists at ${lockFile} — another supervisor may be starting`);
    }
    throw err;
  }

  const store = new RunStore(join(stateDir, "runs"));
  const mockAgentExecutor = new MockAgentExecutor({});
  const acpxAgentExecutor = new AgentExecutor();
  const programExecutor = new ProgramExecutor();

  // Startup recovery: reset orphaned running/paused nodes to pending, set Run to paused.
  // Graceful shutdown writes running→paused, so after a clean restart we also need
  // to handle paused nodes. After a crash, running nodes are also reset.
  for (const runId of store.listRunIds()) {
    const meta = store.readRunMeta(runId);
    if (meta?.status === "running" || meta?.status === "paused") {
      let anyReset = false;
      for (const nodeState of store.listNodeStates(runId)) {
        if (nodeState.state === "running" || nodeState.state === "paused") {
          nodeState.state = "pending";
          store.writeNodeState(runId, nodeState);
          anyReset = true;
        }
      }
      if (anyReset || meta.status === "running") {
        meta.status = "paused";
        meta.updatedAt = new Date().toISOString();
        store.writeRunMeta(runId, meta);
      }
    }
  }

  const { app, getLastActiveAt, setHealthOverrides } = createSupervisorApp(
    config, store, mockAgentExecutor, programExecutor, acpxAgentExecutor
  );

  // Start the HTTP server on random port
  let httpServer: ReturnType<typeof serve> | undefined;
  const startedAt = new Date().toISOString();
  let boundPort = 0;

  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      boundPort = info.port;
      console.log(`acpus supervisor listening on ${info.address}:${info.port}`);
      resolve();
    });
  });

  const endpoint = `http://127.0.0.1:${boundPort}`;
  const workspace = resolve(stateDir, "..");

  // Write supervisor metadata for discovery
  const metadata: SupervisorMetadata = {
    schemaVersion: 1,
    workspace,
    pid: process.pid,
    endpoint,
    startedAt,
    version: "0.1.0"
  };
  writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), "utf8");

  // Push health overrides so GET /health reports the correct endpoint/startedAt
  setHealthOverrides({ startedAt, endpoint });

  // Remove lock file after metadata is written
  try { rmSync(lockFile); } catch { /* ignore */ }

  // ─── Idle shutdown ───────────────────────────────────────────────

  const idleCheckInterval = setInterval(() => {
    if (Date.now() - getLastActiveAt() > idleTimeoutMs) {
      console.log("Supervisor idle timeout — shutting down.");
      shutdown();
    }
  }, 30_000);

  // ─── Graceful shutdown ───────────────────────────────────────────

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down supervisor...");

    clearInterval(idleCheckInterval);

    // Save all running nodes as paused, set Run metadata to paused
    for (const runId of store.listRunIds()) {
      const meta = store.readRunMeta(runId);
      if (meta?.status === "running") {
        for (const nodeState of store.listNodeStates(runId)) {
          if (nodeState.state === "running") {
            nodeState.state = "paused";
            store.writeNodeState(runId, nodeState);
          }
        }
        meta.status = "paused";
        meta.updatedAt = new Date().toISOString();
        store.writeRunMeta(runId, meta);
      }
    }

    // Remove metadata and lock files
    try { if (existsSync(metadataFile)) rmSync(metadataFile); } catch { /* ignore */ }
    try { if (existsSync(lockFile)) rmSync(lockFile); } catch { /* ignore */ }

    // Close the HTTP server gracefully, then exit
    if (httpServer) {
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000);
    } else {
      process.exit(0);
    }
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return metadata;
}
