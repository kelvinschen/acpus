import { describe, expect, it } from "vitest";
import * as executor from "@acpus/agent-executor";

describe("@acpus/agent-executor public API", () => {
  it("exports only resolved agent execution primitives", () => {
    expect(Object.keys(executor).sort()).toEqual([
      "executeAgentTurn",
    ]);
  });
});
