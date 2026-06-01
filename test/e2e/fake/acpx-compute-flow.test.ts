import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareRun } from "../../../src/runtime/run-workflow.js";
import { syncRun } from "../../../src/runtime/sync.js";
import { WorkflowSpecSchema } from "../../../src/schema/workflow-spec.js";

describe("deterministic runtime program stages", () => {
  it("executes compute-only discovery and decision without acpx flow artifacts", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-contract-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
      name: "compute-contract",
      root: "discover",
      inputs: { cwd: { type: "path", default: cwd } },
      roles: {},
      limits: { stageTimeoutMinutes: 1 },
      stages: [
        { id: "discover", kind: "discover", method: "glob", args: { scope: ["**/*.txt"] }, output: "files" },
        {
          id: "decide",
          kind: "decisionGate",
          mode: "program",
          dependsOn: ["discover"],
          rules: [{ when: { source: "outputs.discover.files", op: "exists" }, to: "blocked" }],
          default: "blocked"
        },
        { id: "gate", kind: "gate", dependsOn: ["decide"] }
      ]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });
    const index = await syncRun(cwd, prepared.logicalRunId);
    const discover = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "discover.json"), "utf8")) as { files: unknown[] };
    const decision = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "decide.json"), "utf8")) as { status: string };

    expect(index.status).toBe("blocked");
    expect(discover.files).toHaveLength(1);
    expect(decision.status).toBe("blocked");
    await expect(fs.stat(path.join(prepared.dir, "workflow.flow.ts"))).rejects.toBeTruthy();
  });
});
