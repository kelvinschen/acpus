import { describe, expect, it } from "vitest";
import {
  createAgentActivityProjector,
  createAgentToolActivityProjector,
} from "../src/inspection/agent-activity-projection.js";
import type {
  AgentObservationCurrent,
  AgentObservationInspectionProjection,
  AgentObservationTurn,
} from "../src/observations/log.js";
import type { RunInspectionStatus } from "../src/inspection/types.js";

describe("Agent activity projection", () => {
  it.each([
    ["starting", "starting"],
    ["responding", "responding"],
    ["thinking", "reported-thought"],
    ["planning", "planning"],
    ["tool", "tool"],
    ["repairing", "output-repair"],
    ["settled", "settling"],
  ] as const)("maps Observation phase %s to public phase %s", (phase, expected) => {
    expect(project(projection([turn(1)], [current(1, phase)]))).toMatchObject({
      phase: expected,
      current: {
        kind: "agent",
        attemptId: "attempt-1",
        attemptNo: 1,
        turn: 1,
        phase: expected,
      },
    });
  });

  it("does not fall back to an older Turn when the latest Turn has no current", () => {
    expect(project(projection(
      [turn(1, { state: "settled" }), turn(2)],
      [current(1, "settled", { state: "settled" })],
    ))).toBeUndefined();
  });

  it("retains only active tool evidence in current activity", () => {
    const activity = project(projection([turn(1)], [current(1, "tool", {
      tools: {
        active: [{ name: "Bash", status: "running", updatedAt: "2026-08-03T00:00:02.000Z" }],
        recent: { name: "Read", status: "completed", updatedAt: "2026-08-03T00:00:01.000Z" },
        omittedActive: 0,
      },
    })]));

    expect(activity?.current?.tools).toEqual({
      active: [{ name: "Bash", status: "running", updatedAt: "2026-08-03T00:00:02.000Z" }],
      omittedActive: 0,
    });
  });

  it.each([
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "not_selected",
  ] satisfies RunInspectionStatus[])("lets terminal lifecycle override recording activity for %s", status => {
    const activity = project(
      projection([turn(1)], [current(1, "tool", {
        tools: {
          active: [{ name: "Bash", status: "running", updatedAt: "2026-08-03T00:00:02.000Z" }],
          omittedActive: 0,
        },
      })]),
      { status },
    );

    expect(activity).toMatchObject({
      phase: "settled",
      turn: 1,
      current: { phase: "settled", turn: 1 },
    });
    expect(activity?.current).not.toHaveProperty("tools");
  });

  it("projects terminal lifecycle without Observation evidence", () => {
    expect(createAgentActivityProjector()({
      status: "completed",
      updatedAt: "2026-08-03T00:00:03.000Z",
    })).toEqual({
      phase: "settled",
      updatedAt: "2026-08-03T00:00:03.000Z",
    });
  });

  it("projects only the latest active or recent tool metadata", () => {
    const active = projection([turn(1)], [current(1, "tool", {
      tools: {
        active: [{
          name: "browser.screenshot",
          title: "Capture the current page",
          status: "running",
          input: { text: "/private/path", originalBytes: 13, truncated: false },
          updatedAt: "2026-08-03T00:00:02.000Z",
        }],
        recent: {
          name: "terminal.exec",
          status: "completed",
          output: { text: "private output", originalBytes: 14, truncated: false },
          updatedAt: "2026-08-03T00:00:01.000Z",
        },
        omittedActive: 0,
      },
    })]);
    const recent = projection([turn(1)], [current(1, "between", {
      tools: {
        active: [],
        recent: {
          name: "terminal.exec",
          status: "failed",
          output: { text: "private output", originalBytes: 14, truncated: false },
          updatedAt: "2026-08-03T00:00:02.000Z",
        },
        omittedActive: 0,
      },
    })]);

    expect(createAgentToolActivityProjector(active)("attempt-1")).toEqual({
      tool: {
        name: "browser.screenshot",
        title: "Capture the current page",
        state: "running",
      },
      turn: 1,
    });
    expect(createAgentToolActivityProjector(recent)("attempt-1")).toEqual({
      tool: { name: "terminal.exec", state: "failed" },
      turn: 1,
    });
    expect(JSON.stringify(createAgentToolActivityProjector(active)("attempt-1")))
      .not.toMatch(/private|input|output|toolCallId/);
  });
});

type AgentActivitySubject = Parameters<ReturnType<typeof createAgentActivityProjector>>[0];

function project(
  observations: AgentObservationInspectionProjection,
  overrides: Partial<AgentActivitySubject> = {},
) {
  return createAgentActivityProjector(observations)({
    status: "running",
    updatedAt: "2026-08-03T00:00:03.000Z",
    attemptId: "attempt-1",
    attemptNo: 1,
    ...overrides,
  });
}

function projection(
  turns: AgentObservationTurn[],
  currents: AgentObservationCurrent[],
): AgentObservationInspectionProjection {
  return {
    version: 1,
    turns,
    currents,
    entries: [],
    retentionOmittedBefore: 0,
    olderEntryCount: 0,
    hasOlderEntries: false,
  };
}

function turn(
  number: number,
  overrides: Partial<AgentObservationTurn> = {},
): AgentObservationTurn {
  return {
    runId: "run-1",
    attemptId: "attempt-1",
    nodeKey: "agent~1",
    nodeId: "agent",
    attemptNo: 1,
    turn: number,
    promptKind: "task",
    state: "recording",
    completeness: "complete",
    gapCount: 0,
    eventCount: 1,
    unknownEventCount: 0,
    startedAt: `2026-08-03T00:00:0${number}.000Z`,
    ...overrides,
  };
}

function current(
  turn: number,
  phase: AgentObservationCurrent["phase"],
  overrides: Partial<AgentObservationCurrent> = {},
): AgentObservationCurrent {
  return {
    attemptId: "attempt-1",
    turn,
    promptKind: "task",
    phase,
    updatedAt: `2026-08-03T00:00:0${turn}.000Z`,
    state: "recording",
    completeness: "complete",
    ...overrides,
  };
}
