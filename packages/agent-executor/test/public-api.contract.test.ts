import * as api from "@acpus/agent-executor";
import { describe, expect, it } from "vitest";

describe("@acpus/agent-executor public API", () => {
  it("exposes only the Session Supervisor ownership seam", () => {
    expect(Object.keys(api).sort()).toEqual([
      "createAgentSessionSupervisor",
      "inspectAcpOwnership",
    ]);
  });
});
