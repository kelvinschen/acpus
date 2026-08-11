import { describe, expect, it } from "vitest";
import { workflowPreparationCliError } from "../src/workflow/preparation.js";

describe("workflow preparation CLI adapter", () => {
  it("preserves compile and package-lock phases", () => {
    const sourceError = workflowPreparationCliError({
      type: "source-invalid",
      phase: "source",
      message: "Workflow is outside source root.",
    });
    const compileError = workflowPreparationCliError({
      type: "compile-failed",
      phase: "compile",
      message: "Worker exited before returning a result.",
      failure: {
        type: "worker-system-failed",
        message: "Worker exited before returning a result.",
      },
    });
    const lockError = workflowPreparationCliError({
      type: "package-lock-read-failed",
      phase: "lock",
      path: "/workspace/pnpm-lock.yaml",
      message: "Package lock could not be read.",
    });

    expect(sourceError.result).toEqual({
      ok: false,
      phase: "source",
      message: "Workflow is outside source root.",
    });
    expect(compileError.result).toEqual({
      ok: false,
      phase: "compile",
      message: "Worker exited before returning a result.",
    });
    expect(lockError.result).toEqual({
      ok: false,
      phase: "lock",
      message: "Package lock could not be read.",
    });
  });
});
