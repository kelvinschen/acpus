import * as api from "@acpus/agent-executor";
import { describe, expect, it } from "vitest";

describe("@acpus/agent-executor public API", () => {
  it("exposes the managed attempt executor", () => {
    expect(Object.keys(api).sort()).toEqual([
      "acpxSessionProjectionPath",
      "createManagedAcpExecutor",
      "inspectAcpOwnership",
      "recoverAcpOwnership",
    ]);
    expect(api.acpxSessionProjectionPath("record/with spaces?"))
      .toBe("sessions/record%2Fwith%20spaces%3F.json");
  });
});
