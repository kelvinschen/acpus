import { describe, expect, it } from "vitest";
import {
  ownershipHealthProjection,
  withInspectionOwnershipHealth,
} from "../src/inspection/ownership-health.js";
import type { InspectionRead } from "../src/inspection/types.js";

describe("Agent Session ownership health projection", () => {
  it("treats a global ownership decode failure as unverified, not healthy", () => {
    const read: InspectionRead = {
      kind: "run",
      run: {
        id: "run-1",
        name: "review",
        status: "running",
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:01.000Z",
        agentSessions: [{
          scope: "node",
          agentSessionId: "session-1",
          generation: 1,
          lifecycle: "active",
          currentBinding: { attemptId: "attempt-1", operation: "start", promptOrigin: "authored" },
          checkpoint: { value: "owned_in_flight", attemptId: "attempt-1", turnId: "turn-1", promptOrigin: "authored" },
        }],
      },
      counts: { total: 1, running: 1 },
      tree: [],
    };

    const projected = withInspectionOwnershipHealth(read, ownershipHealthProjection({
      degraded: 1,
      orphaned: 0,
      manifests: [],
    }));

    expect(projected.kind === "run" ? projected.run.agentSessions : undefined)
      .toEqual([expect.objectContaining({ agentSessionId: "session-1", ownershipHealth: "unverified" })]);
  });
});
