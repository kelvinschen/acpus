import { describe, expect, it } from "vitest";
import { failureFromAcpRuntime } from "../src/worker-failure.js";

describe("ACP runtime failure mapping", () => {
  it("identifies a static config failure at the session option boundary", () => {
    expect(failureFromAcpRuntime(new Error("unsupported option"), "session.set_config_option")).toEqual({
      kind: "config",
      origin: "provider",
      message: "unsupported option",
      upstream: { source: "acpx", operation: "session.set_config_option" },
    });
  });
});
