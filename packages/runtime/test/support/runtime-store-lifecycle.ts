import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { DatabaseSync } from "node:sqlite";
import {
  ensureRuntimeLayout,
  resolveRuntimeLayout,
  resolveRuntimeWorkspaceLayout,
  type RuntimeLayoutOptions,
} from "../../src/runtime-layout.js";
import { openRuntimeStoreAtLayout } from "../../src/store/store.js";

export type LegacyRunSummary = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export async function createLegacyStore(
  workspace: string,
  storageVersion: number,
  run?: LegacyRunSummary,
  options: RuntimeLayoutOptions = {},
): Promise<void> {
  const initialized = await ensureRuntimeLayout(workspace, options);
  if (initialized.isErr()) throw new Error(initialized.error.message);
  const store = await openRuntimeStoreAtLayout(initialized.value, { prevalidated: true });
  store.close();
  const current = resolveRuntimeLayout(workspace, options);
  if (run) {
    const database = new DatabaseSync(current.databasePath);
    try {
      database.prepare(`
        INSERT INTO runs (
          id, name, status, workflow_entry, source_graph_digest, created_at, updated_at
        ) VALUES (?, ?, ?, 'workflow.ts', 'sha256:test', ?, ?)
      `).run(run.id, run.name, run.status, run.createdAt, run.updatedAt);
    } finally {
      database.close();
    }
  }
  const database = new DatabaseSync(current.databasePath);
  try {
    database.exec(`PRAGMA user_version = ${storageVersion}; PRAGMA wal_checkpoint(TRUNCATE)`);
  } finally {
    database.close();
  }

  const workspaceLayout = resolveRuntimeWorkspaceLayout(workspace, options);
  const manifest = JSON.parse(await readFile(current.manifestPath, "utf8")) as Record<string, unknown>;
  await mkdir(workspaceLayout.workspaceRoot, { recursive: true });
  await rename(current.runtimeRoot, workspaceLayout.legacyRuntimeRoot);
  await rm(workspaceLayout.generationsRoot, { recursive: true, force: true });
  await writeFile(workspaceLayout.manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    workspaceKey: manifest.workspaceKey,
    canonicalPath: manifest.canonicalPath,
    platform: manifest.platform,
    createdAt: manifest.createdAt,
  }, null, 2)}\n`);
}

export async function startPredecessorDaemon(
  workspace: string,
  options: { blockShutdown?: boolean; protocolVersion?: number } = {},
): Promise<{
  statusRequests(): number;
  shutdownRequests(): number;
  close(): Promise<void>;
}> {
  const endpoint = resolveRuntimeWorkspaceLayout(workspace).daemonEndpoint;
  let statusRequests = 0;
  let shutdownRequests = 0;
  let closed = false;
  const server = createServer({ allowHalfOpen: true }, socket => {
    const chunks: Buffer[] = [];
    let handled = false;
    const respond = () => {
      if (handled) return;
      let request: { method?: unknown };
      try {
        request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method?: unknown };
      } catch {
        return;
      }
      handled = true;
      if (request.method === "status") {
        statusRequests += 1;
        socket.end(JSON.stringify({
          ok: true,
          result: {
            status: "ok",
            pid: process.pid,
            generation: 1,
            protocolVersion: options.protocolVersion ?? 3,
            packageVersion: "0.15.0-test",
          },
        }));
        return;
      }
      shutdownRequests += 1;
      if (options.blockShutdown) {
        socket.end(JSON.stringify({
          ok: false,
          error: { code: "CONTROL_CONFLICT", message: "Daemon has active runtime users." },
        }));
        return;
      }
      socket.end(JSON.stringify({ ok: true, result: { status: "shutdown" } }));
      if (!closed) {
        closed = true;
        server.close();
      }
    };
    socket.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE"
        && (error as NodeJS.ErrnoException).code !== "ECONNRESET") throw error;
    });
    socket.on("data", chunk => {
      chunks.push(Buffer.from(chunk));
      respond();
    });
    socket.on("end", respond);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return {
    statusRequests: () => statusRequests,
    shutdownRequests: () => shutdownRequests,
    close: () => closeServer(server, () => { closed = true; }),
  };
}

async function closeServer(server: Server, markClosed: () => void): Promise<void> {
  if (!server.listening) return;
  markClosed();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
