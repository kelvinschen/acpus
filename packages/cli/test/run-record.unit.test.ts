import { describe, expect, it } from "vitest";
import type { RunDetails } from "@acpus/runtime";
import { toRunRecord } from "../src/runs/record.js";

describe("run record projection", () => {
  it("preserves compact progress freshness", () => {
    const run: RunDetails = {
      id: "run_1",
      name: "projection",
      status: "running",
      workflowEntry: "workflow.ts",
      sourceGraphDigest: "sha256:graph",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:02.000Z",
      progressVersion: 3,
      progressUpdatedAt: "2026-07-11T00:00:01.000Z",
      input: {},
      hooks: [],
      eventCount: 4,
      nodeCount: 1,
      execution: { state: "active", lastStatus: "running" },
    };

    expect(toRunRecord(run)).toEqual({
      id: "run_1",
      name: "projection",
      status: "running",
      workflowEntry: "workflow.ts",
      sourceGraphDigest: "sha256:graph",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:02.000Z",
      progressVersion: 3,
      progressUpdatedAt: "2026-07-11T00:00:01.000Z",
    });
  });
});
