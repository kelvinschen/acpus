import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureProcessIdentity,
  probeProcessIdentity,
  probeProcessLiveness,
} from "../src/process-liveness.js";

describe("process liveness", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a successful signal-zero probe as alive", () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(probeProcessLiveness(123)).toBe("alive");
  });

  it.each([
    ["ESRCH", "dead"],
    ["EPERM", "alive"],
    ["EACCES", "unknown"],
  ] as const)("maps %s to %s", (code, expected) => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });

    expect(probeProcessLiveness(123)).toBe(expected);
  });

  it("falls back to PID liveness when no start token is available", () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(probeProcessIdentity({ pid: 123 })).toBe("alive");
  });

  it("keeps an unreadable expected start token conservative", () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(probeProcessIdentity({ pid: Number.MAX_SAFE_INTEGER, startToken: "expected" }))
      .toBe("unknown");
  });

  it.skipIf(process.platform !== "linux")("distinguishes a reused PID by its start token", () => {
    const identity = captureProcessIdentity();
    if (identity.startToken === undefined) throw new Error("Expected a Linux process start token.");

    expect(probeProcessIdentity(identity)).toBe("alive");
    expect(probeProcessIdentity({ ...identity, startToken: `${identity.startToken}:reused` }))
      .toBe("dead");
  });
});
