import type { RunState } from "@acpus/runtime";
import { describe, expect, it } from "vitest";
import { formatRunShow } from "../src/runs-show.js";

describe("formatRunShow", () => {
  it("prints compact activity for running Agent Steps from Node telemetry", async () => {
    const run: RunState = {
      runId: "run-1",
      workflowName: "demo",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:59:00.000Z",
      updatedAt: "2026-06-10T10:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
          nodeId: "review",
          kind: "run.agent",
          state: "running",
          attempt: 1,
          agentTelemetry: {
            currentAttempt: 1,
            attempts: [{
              attempt: 1,
              state: "running",
              startedAt: "2026-06-10T09:59:59.000Z",
              updatedAt: "2026-06-10T10:00:00.000Z",
              context: { used: 25293, size: 190000, updatedAt: "2026-06-10T10:00:00.000Z" },
              input: { preview: "prompt", truncated: false, originalBytes: 6, headBytes: 6 },
              tools: {
                totalToolCallCount: 2,
                droppedToolCallCount: 0,
                recentCalls: [
                  { toolCallId: "a", title: "Read", status: "completed", startedAt: "2026-06-10T10:00:00.000Z", updatedAt: "2026-06-10T10:00:00.000Z" },
                  { toolCallId: "b", title: "Bash", status: "pending", startedAt: "2026-06-10T10:00:00.000Z", updatedAt: "2026-06-10T10:00:00.000Z" }
                ]
              }
            }]
          }
        }
      ]
    };

    const output = await formatRunShow(run, undefined, new Date("2026-06-10T10:00:12.000Z").getTime());

    expect(output).toContain("workflow/review  [run.agent]  running  attempt=1");
    expect(output).toContain("Activity: updated=12s ago; tool_calls=2; recent=Read, Bash; context=25k/190k");
  });

  it("does not print activity for non-running Agent Steps", async () => {
    const run: RunState = {
      runId: "run-2",
      workflowName: "demo",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:59:00.000Z",
      updatedAt: "2026-06-10T10:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
            nodeId: "review",
            kind: "run.agent",
            state: "completed",
            attempt: 1
          }
        ]
      };

    const output = await formatRunShow(run, {
      getArtifactPath: async () => {
        throw new Error("should not resolve completed transcripts");
      }
    });

    expect(output).not.toContain("Activity:");
  });

  it("renders Forked Run lineage on the run header", async () => {
    const run: RunState = {
      runId: "fork-1",
      workflowName: "demo",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:59:00.000Z",
      updatedAt: "2026-06-10T10:00:10.000Z",
      runAttempt: 1,
      lineage: {
        sourceRunId: "source-run-1",
        forkOriginNodeKey: "workflow/build",
        inheritedNodeCount: 2
      },
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).toContain("Forked From: source-run-1 (origin=workflow/build, inherited=2)");
  });
});
