import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveReport } from "../../src/reports/server.js";
import { writeRunIndex } from "../../src/run-index/read-write.js";
import { syncRun } from "../../src/runtime/sync.js";
import { createReportFixture, minimalReportView } from "../helpers/report-fixtures.js";

describe("live report server", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("serves snapshots over SSE by syncing existing run artifacts only", async () => {
    const fixture = await createReportFixture("completed-success");
    const syncCalls: unknown[] = [];
    const server = await serveReport({
      cwd: fixture.cwd,
      runId: fixture.runId,
      host: "127.0.0.1",
      port: 0,
      intervalMs: 50,
      renderShell: async () => "<!doctype html><html><body>live</body></html>",
      sync: async (_cwd, _runId, options) => {
        syncCalls.push(options);
        return fixture.index;
      },
      build: async () => ({ ...minimalReportView(fixture.runId), mode: "live" })
    });
    servers.push(server);

    const health = await fetch(new URL("/healthz", server.url));
    await expect(health.json()).resolves.toMatchObject({ ok: true, runId: fixture.runId });
    expect((await fetch(new URL("/resume", server.url))).status).toBe(404);
    const events = await readSse(new URL("/events", server.url).toString(), "snapshot");

    expect(events).toContain("event: hello");
    expect(events).toContain("event: snapshot");
    expect(syncCalls).toContainEqual({ startPending: false });
  });

  it("does not start pending runtime turns during report sync", async () => {
    const fixture = await createReportFixture("completed-success");
    const pending = {
      ...fixture.index,
      status: "pending" as const,
      stages: Object.fromEntries(Object.entries(fixture.index.stages).map(([stageId, stage]) => [stageId, { ...stage, status: "pending" as const }])),
      attempts: {},
      agentUsage: { planned: fixture.index.agentUsage.planned, actual: 0, repairCalls: 0, recoveryCalls: 0 },
      finalVerdict: undefined
    };
    await writeRunIndex(fixture.cwd, pending);

    const synced = await syncRun(fixture.cwd, fixture.runId, { startPending: false });

    expect(synced.status).toBe("running");
    expect(synced.stages.plan).toMatchObject({ status: "pending" });
    expect(Object.keys(synced.attempts)).toHaveLength(0);
    await expect(fs.stat(path.join(fixture.dir, "events.ndjson"))).resolves.toBeTruthy();
  });
});

async function readSse(url: string, requiredEvent: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    expect(response.ok).toBe(true);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response body");
    let text = "";
    while (!text.includes(`event: ${requiredEvent}`)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
