import { afterEach, describe, expect, it, vi } from "vitest";
import { probeProcessLiveness } from "../src/process-liveness.js";

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
});
