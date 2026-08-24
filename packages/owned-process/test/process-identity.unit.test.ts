import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureProcessIdentity,
  probeProcessIdentity,
  probeProcessTarget,
  readProcessStartToken,
} from "../src/index.js";

describe("owned process identity", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [undefined, "live"],
    ["EPERM", "live"],
    ["ESRCH", "dead"],
    ["EACCES", "unverified"],
  ] as const)("maps signal-zero evidence %s to %s", (code, expected) => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (code !== undefined) throw Object.assign(new Error(code), { code });
      return true;
    });

    expect(probeProcessTarget({ pid: 123 })).toBe(expected);
  });

  it("keeps unreadable identity evidence unverified", () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(probeProcessIdentity({ pid: Number.MAX_SAFE_INTEGER, startToken: "expected" }))
      .toBe("unverified");
  });

  it.skipIf(process.platform !== "linux")("distinguishes matching and reused Linux identities", () => {
    const identity = captureProcessIdentity();
    expect(identity.startToken).toMatch(/^linux:\d+$/u);
    expect(readProcessStartToken(identity.pid)).toBe(identity.startToken);
    expect(probeProcessIdentity(identity)).toBe("match");
    expect(probeProcessIdentity({ ...identity, startToken: `${identity.startToken}:reused` }))
      .toBe("mismatch");
  });
});
