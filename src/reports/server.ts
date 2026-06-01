import crypto from "node:crypto";
import http, { type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { buildRunReportView, type RunReportView } from "../projections/run-report.js";
import { runDir } from "../run-index/paths.js";
import { readRunIndex, type RunIndex } from "../run-index/read-write.js";
import { syncRun } from "../runtime/sync.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../schema/workflow-spec.js";
import { renderLiveReportShell } from "./html.js";

export type ReportServerOptions = {
  cwd: string;
  runId: string;
  host: string;
  port: number;
  intervalMs: number;
  open?: boolean;
  sync?: typeof syncRun;
  build?: typeof buildRunReportView;
  renderShell?: typeof renderLiveReportShell;
};

type Client = {
  id: string;
  response: ServerResponse;
};

export async function serveReport(options: ReportServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const sync = options.sync ?? syncRun;
  const build = options.build ?? buildRunReportView;
  const clients = new Map<string, Client>();
  let latestHash = "";
  let latestView: RunReportView | undefined;
  let closed = false;

  async function computeSnapshot(): Promise<RunReportView> {
    const index = await sync(options.cwd, options.runId, { startPending: false });
    const spec = await readRunSpec(options.cwd, options.runId);
    return build(options.cwd, spec, index, { mode: "live" });
  }

  function broadcast(event: string, data: unknown): void {
    const encoded = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients.values()) client.response.write(encoded);
  }

  async function tick(): Promise<void> {
    if (closed) return;
    try {
      latestView = await computeSnapshot();
      const hash = hashValue(latestView);
      if (hash !== latestHash) {
        latestHash = hash;
        broadcast("snapshot", latestView);
      } else {
        broadcast("heartbeat", { at: new Date().toISOString(), runId: options.runId });
      }
    } catch (error) {
      broadcast("error", {
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      });
    }
  }

  const shell = await (options.renderShell ?? renderLiveReportShell)({ runId: options.runId });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${options.host}:${options.port}`}`);
    if (request.method !== "GET") {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(shell);
      return;
    }
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, runId: options.runId, clients: clients.size }));
      return;
    }
    if (url.pathname === "/events") {
      const id = crypto.randomBytes(8).toString("hex");
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      clients.set(id, { id, response });
      response.write(`event: hello\ndata: ${JSON.stringify({ version: "acpx-workflow-orchestrator.report/v1", runId: options.runId })}\n\n`);
      if (latestView) response.write(`event: snapshot\ndata: ${JSON.stringify(latestView)}\n\n`);
      request.on("close", () => clients.delete(id));
      return;
    }
    if (url.pathname === "/api/attempt") {
      const relativePath = url.searchParams.get("path") ?? "";
      const kind = url.searchParams.get("kind") ?? "";
      if (!["prompt", "raw", "parse", "output"].includes(kind)) {
        response.writeHead(400).end("Invalid attempt artifact kind");
        return;
      }
      const activeRunDir = runDir(options.runId, options.cwd);
      const fileName = kind === "prompt" ? "prompt.md" : kind === "raw" ? "raw.txt" : `${kind}.json`;
      const target = path.resolve(activeRunDir, relativePath, fileName);
      const root = path.resolve(activeRunDir);
      if (!target.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      try {
        const text = await fs.readFile(target, "utf8");
        response.writeHead(200, { "content-type": kind === "prompt" || kind === "raw" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8" });
        response.end(text);
      } catch {
        response.writeHead(404).end("Not found");
      }
      return;
    }
    response.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${options.host}:${actualPort}/`;
  const timer = setInterval(() => void tick(), options.intervalMs);
  await tick();
  if (options.open) openBrowser(url);
  return {
    url,
    close: async () => {
      closed = true;
      clearInterval(timer);
      for (const client of clients.values()) client.response.end();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function readRunSpec(cwd: string, runId: string): Promise<WorkflowSpec> {
  return WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(runDir(runId, cwd), "workflow.spec.json"), "utf8")));
}

function hashValue(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening the browser is best effort; the CLI still prints the URL.
  }
}
