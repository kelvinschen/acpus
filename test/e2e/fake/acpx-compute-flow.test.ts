import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareRun } from "../../../src/runtime/run-workflow.js";
import { syncRun } from "../../../src/runtime/sync.js";
import { WorkflowSpecSchema } from "../../../src/schema/workflow-spec.js";

describe("deterministic runtime program stages", () => {
  it("executes compute-only route from YAML run artifacts", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpus-contract-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpus.workflow/v1",
      name: "compute-contract",
      root: "decide",
      input: { schema: "{cwd:string}", default: { cwd } },
      limits: { stageTimeoutMinutes: 1 },
      stages: [
        {
          id: "decide",
          kind: "route",
          mode: "program",
          rules: [{ when: { source: "outputs.missing", op: "exists" }, to: "gate" }],
          routes: ["gate"]
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["decide"] }
      ]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });
    const index = await syncRun(cwd, prepared.logicalRunId);
    const decision = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "decide.json"), "utf8")) as { status: string };

    expect(index.status).toBe("blocked");
    expect(decision.status).toBe("blocked");
    await expect(fs.stat(path.join(prepared.dir, "workflow.spec.yaml"))).resolves.toBeTruthy();
  });
});
