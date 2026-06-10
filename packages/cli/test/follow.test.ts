import { describe, expect, it, vi } from "vitest";
import { followRun } from "../src/follow.js";
import type { RunState } from "@acpus/runtime";

describe("followRun", () => {
  it("returns when the followed run is paused", async () => {
    const run: RunState = {
      runId: "run-paused",
      workflowName: "paused-workflow",
      status: "paused",
      irDigest: "sha256:ir",
      inputDigest: "sha256:input",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      version: "0.1.0"
    };
    const client = {
      clientKind: undefined,
      getRun: vi.fn(async () => run),
      getNodeStates: vi.fn(async () => [])
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(followRun(client as any, "run-paused", { intervalMs: 1 })).resolves.toBe("paused");
    } finally {
      write.mockRestore();
    }

    expect(client.getRun).toHaveBeenCalledTimes(1);
  });
});
