import type { AcpError } from "@acpus/acp";
import { describe, expect, it } from "vitest";
import { failureFromAcpError } from "../src/worker-failure.js";

describe("ACP failure mapping", () => {
  it("identifies a rejected session option as a provider configuration failure", () => {
    const error: AcpError = {
      type: "configuration",
      operation: "configure_session",
      message: "unsupported option",
      retryable: false,
      code: -32_602,
    };

    expect(failureFromAcpError(error)).toEqual({
      kind: "config",
      origin: "provider",
      retryable: false,
      message: "unsupported option",
      upstream: {
        source: "acp",
        operation: "configure_session",
        code: -32_602,
        origin: "configuration",
      },
    });
  });

  it("identifies an invalid persisted session as a runtime configuration failure", () => {
    const error: AcpError = {
      type: "persistence",
      operation: "open_session",
      message: "projection does not match",
      retryable: false,
      path: "sessions/record.json",
    };

    expect(failureFromAcpError(error)).toMatchObject({
      kind: "config",
      origin: "runtime",
      retryable: false,
      upstream: { source: "acp", operation: "open_session", origin: "persistence" },
    });
  });

  it("normalizes a prompt protocol error to the public turn boundary", () => {
    const error: AcpError = {
      type: "protocol",
      operation: "terminal/output",
      message: "invalid terminal response",
      retryable: true,
      code: "INVALID_RESPONSE",
    };

    expect(failureFromAcpError(error)).toMatchObject({
      kind: "provider_exit",
      origin: "provider",
      retryable: true,
      upstream: {
        source: "acp",
        operation: "run_turn",
        code: "INVALID_RESPONSE",
        origin: "protocol",
      },
    });
  });
});
