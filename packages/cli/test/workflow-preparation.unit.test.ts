import { describe, expect, it } from "vitest";
import { workflowPreparationCliError } from "../src/workflow-preparation.js";

describe("workflow preparation CLI adapter", () => {
  it("preserves the package-lock phase", () => {
    const error = workflowPreparationCliError({
      type: "package-lock-read-failed",
      phase: "lock",
      path: "/workspace/pnpm-lock.yaml",
      message: "Package lock could not be read.",
    });

    expect(error.result).toEqual({
      ok: false,
      phase: "lock",
      message: "Package lock could not be read.",
    });
  });
});
