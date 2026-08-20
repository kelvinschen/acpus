import * as api from "@acpus/acp";
import { describe, expect, it } from "vitest";

describe("@acpus/acp public API", () => {
  it("exports only the stable session opener and binding fingerprinter at runtime", () => {
    expect(Object.keys(api).sort()).toEqual([
      "fingerprintAgentSessionBinding",
      "openAcpSession",
    ]);
  });
});
