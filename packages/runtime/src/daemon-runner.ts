import { createDaemonApp } from "./daemon.js";
import { RunStore } from "./store.js";
import { MockAgentExecutor } from "./executors/mock-agent.js";
import { MockProgramExecutor } from "./executors/mock-program.js";
import type { DaemonConfig } from "./types.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";

/**
 * Start the acpus daemon process.
 * Handles PID file, graceful shutdown, and startup recovery.
 */
export async function startDaemon(config: DaemonConfig = {}): Promise<void> {
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 3839;
  const stateDir = config.stateDir ?? join(process.cwd(), ".acpus");
  const pidFile = join(stateDir, "daemon.pid");

  // Ensure state directory exists
  mkdirSync(stateDir, { recursive: true });

  // Check for existing PID file
  if (existsSync(pidFile)) {
    console.warn(`PID file already exists at ${pidFile}. Another daemon may be running.`);
  }

  const store = new RunStore(join(stateDir, "runs"));
  const agentExecutor = new MockAgentExecutor({});
  const programExecutor = new MockProgramExecutor({});

  // Startup recovery: reset running nodes to pending
  for (const runId of store.listRunIds()) {
    const meta = store.readRunMeta(runId);
    if (meta?.status === "running") {
      for (const nodeState of store.listNodeStates(runId)) {
        if (nodeState.state === "running") {
          nodeState.state = "pending";
          store.writeNodeState(runId, nodeState);
        }
      }
    }
  }

  const app = createDaemonApp(config, store, agentExecutor, programExecutor);

  // Start the HTTP server
  let httpServer: ReturnType<typeof serve> | undefined;
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      console.log(`acpus daemon listening on ${info.address}:${info.port}`);
      resolve();
    });
  });

  // Graceful shutdown
  const shutdown = (): void => {
    console.log("Shutting down daemon...");
    // Save all running nodes as paused
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
    // Remove PID file
    if (existsSync(pidFile)) {
      rmSync(pidFile);
    }
    // Close the HTTP server gracefully, then exit
    if (httpServer) {
      httpServer.close(() => process.exit(0));
      // Fallback: force exit after 5 seconds if server doesn't close
      setTimeout(() => process.exit(0), 5000);
    } else {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Write PID file
  writeFileSync(pidFile, String(process.pid), "utf8");
}
