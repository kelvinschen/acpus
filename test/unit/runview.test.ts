import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewRunView } from "../../src/projections/run-view.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

describe("RunView", () => {
  it("projects workflow preview", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/simple-feature.workflow.spec.json"), "utf8")));
    const view = previewRunView(spec);
    expect(view.workflowName).toBe("simple-feature");
    expect(view.status).toBe("pending");
    expect(view.stages.map((stage) => stage.id)).toContain("summarize");
    expect(view.agentUsage.planned).toBe(4);
  });
});
