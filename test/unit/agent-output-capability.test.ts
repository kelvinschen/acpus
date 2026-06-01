import { describe, expect, it } from "vitest";
import { rawTextOutputCapability } from "../../src/compiler/agent-output-capability.js";

describe("agent output capability", () => {
  it("declares rawText as the current structured-output fallback", () => {
    expect(rawTextOutputCapability("implementation")).toEqual({
      mode: "rawText",
      contract: "implementation",
      schemaName: "final-json.implementation",
      rawTextFallback: true
    });
  });
});
