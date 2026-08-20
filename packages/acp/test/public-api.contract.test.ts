import * as api from "@acpus/acp";
import { describe, expect, it } from "vitest";

describe("@acpus/acp public API", () => {
  it("exports only the stable session opener at runtime", () => {
    expect(Object.keys(api).sort()).toEqual(["openAcpSession"]);
  });
});
