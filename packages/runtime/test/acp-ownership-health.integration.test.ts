import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRuntimeHealth } from "../src/runs/use-cases.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { openRuntimeStore } from "../src/store/store.js";
import { withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe("ACP ownership Doctor projection", () => {
  it("warns about residual ownership without changing the manifest", async () => {
    await withRuntimeWorkspace("doctor-acp-residual", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      await mkdir(layout.acpWorkersRoot, { recursive: true });
      const path = join(layout.acpWorkersRoot, "acp_worker_dea0.json");
      await writeFile(path, JSON.stringify({
        schemaVersion: 1,
        workerId: "acp_worker_dea0",
        runId: "run_1",
        attemptId: "attempt_1",
        sessionName: "session",
        daemon: { pid: 99_999_999, startToken: "pid:99999999", generation: "old" },
        worker: { pid: 99_999_999, startToken: "pid:99999999" },
        state: "degraded",
        createdAt: "2026-07-30T00:00:00.000Z",
      }));
      const before = { bytes: await readFile(path, "utf8"), mtimeMs: (await stat(path)).mtimeMs };

      const report = await getRuntimeHealth(workspace);

      expect(report.checks.find(check => check.area === "acp")).toMatchObject({
        status: "warn",
        message: "ACP ownership warning: degraded=1 orphaned=0",
        details: { degraded: 1, orphaned: 0 },
      });
      expect({ bytes: await readFile(path, "utf8"), mtimeMs: (await stat(path)).mtimeMs }).toEqual(before);
    });
  });
});
