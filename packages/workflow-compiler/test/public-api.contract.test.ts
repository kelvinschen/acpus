import { describe, expect, it } from "vitest";
import * as compiler from "@acpus/workflow-compiler";

describe("@acpus/workflow-compiler public API", () => {
  it("exports only the workflow compiler boundary", () => {
    expect(Object.keys(compiler).sort()).toEqual([
      "WorkflowPreparationError",
      "extractWorkflowMetadata",
      "prepareWorkflow",
      "tryPrepareWorkflow",
    ]);
  });
});
