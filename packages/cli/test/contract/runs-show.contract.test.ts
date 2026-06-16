import type { RunState } from "@acpus/runtime";
import { describe, expect, it } from "vitest";
import { formatRunShow } from "../../src/runs-show.js";

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
          startedAt: "2026-06-10T09:59:00.000Z",
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

    // Compact header
    expect(output).toContain("Run run-1  demo  running");
    // Compact kind
    expect(output).toContain("⠋ workflow/review  [agent]  running");
    // Activity summary
    expect(output).toContain("Activity: updated=12s ago; tool_calls=2; recent=Read, Bash; context=25k/190k");
    // No verbose fields
    expect(output).not.toContain("attempt=1");
    expect(output).not.toContain("Workflow:");
    expect(output).not.toContain("Created:");
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
          attempt: 1,
          startedAt: "2026-06-10T09:59:00.000Z",
          completedAt: "2026-06-10T10:00:02.000Z"
        }
      ]
    };

    const output = await formatRunShow(run, {
      getArtifactPath: async () => {
        throw new Error("should not resolve completed transcripts");
      }
    });

    expect(output).not.toContain("Activity:");
    // Completed node has ✓ glyph and duration
    expect(output).toContain("✓ workflow/review  [agent]  1m2s");
  });

  it("renders Forked Run lineage on the compact header", async () => {
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
    expect(output).toContain("forked from source-run-1 (origin=workflow/build, inherited=2)");
    // Should be on same line as header
    const headerLine = output.split("\n")[0];
    expect(headerLine).toContain("Run fork-1  demo  completed");
    expect(headerLine).toContain("forked from");
  });

  it("skips completed container nodes with no unique error", async () => {
    const run: RunState = {
      runId: "run-3",
      workflowName: "composite-e2e",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        { nodeKey: "workflow", nodeId: "workflow", kind: "pipeline", state: "completed", attempt: 1, startedAt: "2026-06-10T09:00:00.000Z", completedAt: "2026-06-10T09:00:10.000Z" },
        { nodeKey: "workflow/composite", nodeId: "composite", kind: "fanout", state: "completed", attempt: 1 },
        { nodeKey: "workflow/composite/review", nodeId: "review", kind: "run.agent", state: "completed", attempt: 1, startedAt: "2026-06-10T09:00:00.000Z", completedAt: "2026-06-10T09:00:05.000Z" }
      ]
    };

    const output = await formatRunShow(run);
    // Completed pipeline and fanout should be skipped
    expect(output).not.toContain("[pipeline]");
    expect(output).not.toContain("[fanout]");
    // Agent leaf node should appear
    expect(output).toContain("workflow/composite/review  [agent]");
  });

  it("shows non-completed container nodes (pending, running, etc.)", async () => {
    const run: RunState = {
      runId: "run-3b",
      workflowName: "test",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        { nodeKey: "workflow", nodeId: "workflow", kind: "pipeline", state: "running", attempt: 1, startedAt: "2026-06-10T09:00:00.000Z" },
        { nodeKey: "workflow/loop_body/item:skip/lane:2", nodeId: "skip", kind: "loop", state: "pending", attempt: 0 },
        { nodeKey: "workflow/skip_lane/item:skip/lane:2", nodeId: "skip_guard", kind: "guard", state: "completed", attempt: 1 },
        { nodeKey: "workflow/skip_lane/item:alpha/lane:0", nodeId: "alpha_guard", kind: "guard", state: "completed", attempt: 1 }
      ]
    };

    const output = await formatRunShow(run);
    // Running pipeline shown (non-completed)
    expect(output).toContain("⠋ workflow  [pipeline]  running");
    // Pending loop shown (non-completed)
    expect(output).toContain("○ workflow/loop_body/item:skip/lane:2  [loop]  pending");
    // Guard nodes always shown (they are decision points, not containers)
    expect(output).toContain("✓ workflow/skip_lane/item:alpha/lane:0  [guard]");
    expect(output).toContain("✓ workflow/skip_lane/item:skip/lane:2  [guard]");
  });

  it("shows container node with unique error that differs from children", async () => {
    const run: RunState = {
      runId: "run-4",
      workflowName: "test",
      status: "failed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow",
          nodeId: "workflow", kind: "pipeline", state: "failed", attempt: 1,
          error: "pipeline-level error"
        },
        {
          nodeKey: "workflow/review",
          nodeId: "review", kind: "run.agent", state: "failed", attempt: 1,
          error: "agent-level error",
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:00:05.000Z"
        }
      ]
    };

    const output = await formatRunShow(run);
    // Pipeline has a unique error, should appear
    expect(output).toContain("◆ workflow  [pipeline]  failed");
    expect(output).toContain("Error: pipeline-level error");
    // Agent node with different error
    expect(output).toContain("◆ workflow/review  [agent]  failed");
    expect(output).toContain("Error: agent-level error");
  });

  it("deduplicates container error that matches child error", async () => {
    const sharedError = "Agent step 'review' (use: echo) failed (spawn): ACP agent exited before initialize completed";
    const run: RunState = {
      runId: "run-5",
      workflowName: "all-primitives",
      status: "failed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow",
          nodeId: "workflow", kind: "pipeline", state: "failed", attempt: 1,
          error: sharedError
        },
        {
          nodeKey: "workflow/review",
          nodeId: "review", kind: "run.agent", state: "failed", attempt: 1,
          error: sharedError,
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:00:05.000Z"
        }
      ]
    };

    const output = await formatRunShow(run);
    // Pipeline error is same as child, so pipeline should be skipped entirely
    expect(output).not.toContain("[pipeline]");
    // Child error should still appear
    expect(output).toContain("◆ workflow/review  [agent]  failed");
    expect(output).toContain(`Error: ${sharedError}`);
  });

  it("omits attempt=1 and shows attempt when > 1", async () => {
    const run: RunState = {
      runId: "run-6",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        { nodeKey: "workflow/review", nodeId: "review", kind: "run.agent", state: "completed", attempt: 1, startedAt: "2026-06-10T09:00:00.000Z", completedAt: "2026-06-10T09:00:05.000Z" },
        { nodeKey: "workflow/build", nodeId: "build", kind: "run.program", state: "completed", attempt: 3, startedAt: "2026-06-10T09:00:00.000Z", completedAt: "2026-06-10T09:00:03.000Z" }
      ]
    };

    const output = await formatRunShow(run);
    // attempt=1 should not appear
    expect(output).not.toMatch(/review.*attempt=1/);
    // attempt=3 should appear
    expect(output).toContain("attempt=3");
  });

  it("shows artifact count for failed nodes and hides for completed", async () => {
    const run: RunState = {
      runId: "run-7",
      workflowName: "test",
      status: "failed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
          nodeId: "review", kind: "run.agent", state: "failed", attempt: 1,
          error: "something went wrong",
          artifactRefs: ["artifact://a.md", "artifact://b.md", "artifact://c.json", "artifact://d.log"],
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:00:05.000Z"
        },
        {
          nodeKey: "workflow/build",
          nodeId: "build", kind: "run.program", state: "completed", attempt: 1,
          artifactRefs: ["artifact://stdout.log", "artifact://stderr.log"],
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:00:03.000Z"
        }
      ]
    };

    const output = await formatRunShow(run);
    // Failed node shows artifact count
    expect(output).toContain("Artifacts: 4 files");
    // Completed node should NOT show artifacts
    expect(output).not.toContain("Artifacts: 2 files");
    // Should not show full artifact URIs
    expect(output).not.toContain("artifact://");
  });

  it("computes duration from startedAt/completedAt", async () => {
    const run: RunState = {
      runId: "run-8",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
          nodeId: "review", kind: "run.agent", state: "completed", attempt: 1,
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:02:30.000Z"
        }
      ]
    };

    const output = await formatRunShow(run);
    // 2m30s duration
    expect(output).toContain("2m30s");
  });

  it("shows pending node with ○ glyph and no duration", async () => {
    const run: RunState = {
      runId: "run-9",
      workflowName: "test",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        { nodeKey: "workflow/wait", nodeId: "wait", kind: "run.signal", state: "pending", attempt: 1 }
      ]
    };

    const output = await formatRunShow(run);
    expect(output).toContain("○ workflow/wait  [signal]  pending");
  });

  it("compact header includes run duration", async () => {
    const run: RunState = {
      runId: "run-10",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        { nodeKey: "workflow/review", nodeId: "review", kind: "run.agent", state: "completed", attempt: 1, startedAt: "2026-06-10T09:00:00.000Z", completedAt: "2026-06-10T09:00:07.000Z" }
      ]
    };

    const output = await formatRunShow(run);
    const headerLine = output.split("\n")[0];
    expect(headerLine).toContain("Run run-10  test  completed  7s");
  });

  it("shows run-level error below header", async () => {
    const run: RunState = {
      runId: "run-11",
      workflowName: "test",
      status: "failed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      error: "Run-level error: workflow timed out",
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).toContain("Error: Run-level error: workflow timed out");
  });

  it("does not inflate duration for terminal node missing completedAt", async () => {
    const run: RunState = {
      runId: "run-12",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
          nodeId: "review", kind: "run.agent", state: "completed", attempt: 1,
          startedAt: "2026-06-10T09:00:00.000Z"
          // no completedAt — terminal node, should NOT show a duration
        }
      ]
    };

    const output = await formatRunShow(run);
    const nodeLine = output.split("\n").find(l => l.includes("workflow/review"));
    expect(nodeLine).toBe("  ✓ workflow/review  [agent]");
  });

  it("shows duration for running node using Date.now fallback", async () => {
    const run: RunState = {
      runId: "run-13",
      workflowName: "test",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
          nodeId: "review", kind: "run.agent", state: "running", attempt: 1,
          startedAt: "2026-06-10T09:00:00.000Z"
          // no completedAt — running node, should show duration via Date.now
        }
      ]
    };

    const nowMs = new Date("2026-06-10T09:00:30.000Z").getTime();
    const output = await formatRunShow(run, undefined, nowMs);
    // Running node should get duration from startedAt → nowMs
    expect(output).toMatch(/⠋ workflow\/review  \[agent\]  running  \d+s/);
  });

  it("handles empty nodes array gracefully", async () => {
    const run: RunState = {
      runId: "run-14",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: []
    };

    const output = await formatRunShow(run);
    const lines = output.split("\n");
    expect(lines.length).toBe(1); // just the header
    expect(lines[0]).toContain("Run run-14  test  completed  <1s");
  });

  it("handles undefined nodes gracefully", async () => {
    const run: RunState = {
      runId: "run-15",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1
      // nodes is undefined
    };

    const output = await formatRunShow(run);
    const lines = output.split("\n");
    expect(lines.length).toBe(1);
  });

  it("shows awaiting and paused glyphs correctly", async () => {
    const run: RunState = {
      runId: "run-16",
      workflowName: "test",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        { nodeKey: "workflow/signal", nodeId: "signal", kind: "run.signal", state: "awaiting", attempt: 1 },
        { nodeKey: "workflow/hold", nodeId: "hold", kind: "run.agent", state: "paused", attempt: 1 }
      ]
    };

    const output = await formatRunShow(run);
    expect(output).toContain("⏳ workflow/signal  [signal]  awaiting");
    expect(output).toContain("⏸ workflow/hold  [agent]  paused");
  });

  it("cancels node with cancelled glyph", async () => {
    const run: RunState = {
      runId: "run-17",
      workflowName: "test",
      status: "cancelled",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        { nodeKey: "workflow/review", nodeId: "review", kind: "run.agent", state: "cancelled", attempt: 1 }
      ]
    };

    const output = await formatRunShow(run);
    expect(output).toContain("✗ workflow/review  [agent]  cancelled");
  });

  it("does not show artifact count for cancelled nodes", async () => {
    const run: RunState = {
      runId: "run-18",
      workflowName: "test",
      status: "cancelled",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
          nodeId: "review", kind: "run.agent", state: "cancelled", attempt: 1,
          artifactRefs: ["artifact://a.md"]
        }
      ]
    };

    const output = await formatRunShow(run);
    expect(output).not.toContain("Artifacts:");
  });

  it("uses fallback glyph and raw kind for unknown state/kind", async () => {
    const run: RunState = {
      runId: "run-19",
      workflowName: "test",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        // @ts-expect-error — testing unknown kind
        { nodeKey: "workflow/custom", nodeId: "custom", kind: "custom_step", state: "suspended", attempt: 1 }
      ]
    };

    const output = await formatRunShow(run);
    expect(output).toContain("· workflow/custom  [custom_step]  suspended");
  });

  it("shows <1s for sub-second durations", async () => {
    const run: RunState = {
      runId: "run-20",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/fast",
          nodeId: "fast", kind: "run.program", state: "completed", attempt: 1,
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:00:00.200Z" // 200ms
        }
      ]
    };

    const output = await formatRunShow(run);
    expect(output).toContain("<1s");
    expect(output).not.toContain("0s");
  });

  it("shows exact duration at boundaries: 60s→1m, 3600s→1h", async () => {
    const run: RunState = {
      runId: "run-21",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T10:01:00.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/min",
          nodeId: "min", kind: "run.agent", state: "completed", attempt: 1,
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:01:00.000Z" // exactly 60s = 1m
        },
        {
          nodeKey: "workflow/hour",
          nodeId: "hour", kind: "run.agent", state: "completed", attempt: 1,
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T10:00:00.000Z" // exactly 3600s = 1h
        }
      ]
    };

    const output = await formatRunShow(run);
    const minLine = output.split("\n").find(l => l.includes("workflow/min"));
    const hourLine = output.split("\n").find(l => l.includes("workflow/hour"));
    expect(minLine).toContain("1m");
    expect(minLine).not.toContain("60s");
    expect(hourLine).toContain("1h");
    expect(hourLine).not.toContain("60m");
  });

  it("shows duration for paused node using nowMs fallback", async () => {
    const run: RunState = {
      runId: "run-22",
      workflowName: "test",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/hold",
          nodeId: "hold", kind: "run.agent", state: "paused", attempt: 1,
          startedAt: "2026-06-10T09:00:00.000Z"
        }
      ]
    };

    const nowMs = new Date("2026-06-10T09:05:00.000Z").getTime();
    const output = await formatRunShow(run, undefined, nowMs);
    const nodeLine = output.split("\n").find(l => l.includes("workflow/hold"));
    expect(nodeLine).toContain("5m");
  });

  it("scopes error dedup to container's own children, not global", async () => {
    // Two independent subtrees with the same error string.
    // Container in subtree A should NOT be skipped just because subtree B
    // has a leaf with the same error.
    const sharedError = "Connection refused";
    const run: RunState = {
      runId: "run-23",
      workflowName: "test",
      status: "failed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow",
          nodeId: "workflow", kind: "pipeline", state: "failed", attempt: 1,
          error: sharedError
        },
        // Subtree A: pipeline → agent_a
        {
          nodeKey: "workflow/branch_a",
          nodeId: "branch_a", kind: "fanout", state: "failed", attempt: 1,
          error: sharedError
        },
        {
          nodeKey: "workflow/branch_a/agent_a",
          nodeId: "agent_a", kind: "run.agent", state: "failed", attempt: 1,
          error: sharedError,
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:00:05.000Z"
        },
        // Subtree B: agent_b (unrelated, same error)
        {
          nodeKey: "workflow/branch_b",
          nodeId: "branch_b", kind: "fanout", state: "failed", attempt: 1,
          error: sharedError
        },
        {
          nodeKey: "workflow/branch_b/agent_b",
          nodeId: "agent_b", kind: "run.agent", state: "failed", attempt: 1,
          error: sharedError,
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:00:05.000Z"
        }
      ]
    };

    const output = await formatRunShow(run);
    // Each fanout's error matches its own child, so both fanouts should be skipped
    expect(output).not.toContain("[fanout]");
    // But pipeline's error matches children too (they're all descendants), so pipeline also skipped
    expect(output).not.toContain("[pipeline]");
    // Both agent errors should still appear
    expect(output).toContain("◆ workflow/branch_a/agent_a  [agent]  failed");
    expect(output).toContain("◆ workflow/branch_b/agent_b  [agent]  failed");
  });

  it("formatRunDuration preserves seconds remainder in header", async () => {
    const run: RunState = {
      runId: "run-24",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:02:30.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
          nodeId: "review", kind: "run.agent", state: "completed", attempt: 1,
          startedAt: "2026-06-10T09:00:00.000Z",
          completedAt: "2026-06-10T09:02:30.000Z"
        }
      ]
    };

    const output = await formatRunShow(run);
    const headerLine = output.split("\n")[0];
    // Header should show 2m30s, not drop the seconds like the old formatRunDuration did
    expect(headerLine).toContain("2m30s");
  });

  it("suppresses context display when used=0 (measurement lost)", async () => {
    // When an agent fails before the API reports real token usage, the runtime
    // may record used=0. Displaying "0/200k" is misleading — suppress it.
    const run: RunState = {
      runId: "run-25",
      workflowName: "test",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
          nodeId: "review",
          kind: "run.agent",
          state: "running",
          attempt: 1,
          startedAt: "2026-06-10T09:00:00.000Z",
          agentTelemetry: {
            currentAttempt: 1,
            attempts: [{
              attempt: 1,
              state: "running",
              startedAt: "2026-06-10T09:00:00.000Z",
              updatedAt: "2026-06-10T09:00:10.000Z",
              context: { used: 0, size: 200000, updatedAt: "2026-06-10T09:00:10.000Z" },
              input: { preview: "prompt", truncated: false, originalBytes: 6, headBytes: 6 },
              tools: {
                totalToolCallCount: 5,
                droppedToolCallCount: 0,
                recentCalls: [
                  { toolCallId: "a", title: "Read", status: "completed", startedAt: "2026-06-10T09:00:05.000Z", updatedAt: "2026-06-10T09:00:05.000Z" }
                ]
              }
            }]
          }
        }
      ]
    };

    const output = await formatRunShow(run, undefined, new Date("2026-06-10T09:00:12.000Z").getTime());
    // Should NOT show "0/200k" — that's misleading
    expect(output).not.toContain("context=0/");
    // Should still show tool_calls and other activity info
    expect(output).toContain("tool_calls=5");
  });

  it("shows workflow output section for completed run with output", async () => {
    const run: RunState = {
      runId: "run-26",
      workflowName: "review-pipeline",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:05:30.000Z",
      runAttempt: 1,
      output: {
        verdict: "pass",
        final_report_path: "/tmp/report.md",
        blocking_count: 2,
      },
      nodes: [
        { nodeKey: "workflow/review", nodeId: "review", kind: "run.agent", state: "completed", attempt: 1, startedAt: "2026-06-10T09:00:00.000Z", completedAt: "2026-06-10T09:05:28.000Z" }
      ]
    };

    const output = await formatRunShow(run);
    expect(output).toContain("Output:");
    expect(output).toContain("  verdict: pass");
    expect(output).toContain("  final_report_path: /tmp/report.md");
    expect(output).toContain("  blocking_count: 2");
  });

  it("does not show output section when run.output is undefined", async () => {
    const run: RunState = {
      runId: "run-27",
      workflowName: "test",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).not.toContain("Output:");
  });

  it("does not show output section when run.output is empty object", async () => {
    const run: RunState = {
      runId: "run-28",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      output: {},
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).not.toContain("Output:");
  });

  it("shows nested workflow output with proper indentation", async () => {
    const run: RunState = {
      runId: "run-29",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      output: {
        result: {
          score: 0.9,
          label: "positive",
        },
        verdict: "pass",
      },
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).toContain("Output:");
    expect(output).toContain("  result:");
    expect(output).toContain("    score: 0.9");
    expect(output).toContain("    label: positive");
    expect(output).toContain("  verdict: pass");
  });

  it("shows output section with blank line separator after nodes", async () => {
    const run: RunState = {
      runId: "run-30",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      output: { verdict: "pass" },
      nodes: [
        { nodeKey: "workflow/review", nodeId: "review", kind: "run.agent", state: "completed", attempt: 1, startedAt: "2026-06-10T09:00:00.000Z", completedAt: "2026-06-10T09:00:05.000Z" }
      ]
    };

    const output = await formatRunShow(run);
    const lines = output.split("\n");
    // Find the node line and the output section
    const nodeLineIdx = lines.findIndex(l => l.includes("workflow/review"));
    const outputLineIdx = lines.findIndex(l => l === "Output:");
    expect(nodeLineIdx).toBeGreaterThanOrEqual(0);
    expect(outputLineIdx).toBeGreaterThan(nodeLineIdx);
    // There should be a blank line between the last node line and "Output:"
    expect(lines[outputLineIdx - 1]).toBe("");
  });

  it("shows output for run with no nodes", async () => {
    const run: RunState = {
      runId: "run-31",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      output: { result: "ok" },
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).toContain("Output:");
    expect(output).toContain("  result: ok");
  });

  it("handles output with array values", async () => {
    const run: RunState = {
      runId: "run-32",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      output: {
        tags: ["bug", "security", "critical"],
        count: 3,
      },
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).toContain("Output:");
    expect(output).toContain("  tags:");
    expect(output).toContain("    - bug");
    expect(output).toContain("    - security");
    expect(output).toContain("    - critical");
    expect(output).toContain("  count: 3");
  });

  it("does not show output for failed run even when run.output is present", async () => {
    const run: RunState = {
      runId: "run-33",
      workflowName: "test",
      status: "failed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      error: "something failed",
      output: { verdict: "pass", final_report_path: "/tmp/report.md" },
      nodes: [
        { nodeKey: "workflow/review", nodeId: "review", kind: "run.agent", state: "failed", attempt: 1, error: "agent failed", startedAt: "2026-06-10T09:00:00.000Z", completedAt: "2026-06-10T09:00:05.000Z" }
      ]
    };

    const output = await formatRunShow(run);
    expect(output).not.toContain("Output:");
    expect(output).not.toContain("final_report_path:");
  });

  it("does not show output for cancelled run even when run.output is present", async () => {
    const run: RunState = {
      runId: "run-33b",
      workflowName: "test",
      status: "cancelled",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      output: { verdict: "pass" },
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).not.toContain("Output:");
  });

  it("does not show output for paused run even when run.output is present", async () => {
    const run: RunState = {
      runId: "run-33c",
      workflowName: "test",
      status: "paused",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      output: { verdict: "pass" },
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).not.toContain("Output:");
  });

  it("truncates large output at key boundary", async () => {
    // Build an output with >25 lines of YAML
    const outputObj: Record<string, unknown> = {};
    for (let i = 1; i <= 30; i++) {
      outputObj[`key_${i}`] = `value_${i}`;
    }

    const run: RunState = {
      runId: "run-34",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      output: outputObj,
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).toContain("Output:");
    // Should have truncation indicator
    expect(output).toMatch(/\.\.\. \(\d+ more lines\)/);
    // Should NOT contain key_30 (it's beyond the 25-line limit)
    expect(output).not.toContain("key_30");
    // All shown keys should be complete top-level keys
    const outputSection = output.split("Output:\n")[1];
    const contentLines = outputSection!.split("\n");
    // Last content line before indicator should be a top-level key (starts with 2 spaces + non-space)
    const beforeIndicator = contentLines.filter(l => l.startsWith("  ") && !l.includes("..."));
    const lastKey = beforeIndicator[beforeIndicator.length - 1];
    expect(lastKey).toMatch(/^  key_\d+: value_\d+$/);
  });

  it("does not emit dangling top-level key when truncating a large nested first key", async () => {
    // Build an output where the first top-level key has a nested value >25 lines
    const bigItems: string[] = [];
    for (let i = 0; i < 40; i++) {
      bigItems.push(`item_${i}`);
    }

    const run: RunState = {
      runId: "run-35",
      workflowName: "test",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:00:00.000Z",
      updatedAt: "2026-06-10T09:00:10.000Z",
      runAttempt: 1,
      output: {
        big: { items: bigItems },
        verdict: "pass",
      },
      nodes: []
    };

    const output = await formatRunShow(run);
    expect(output).toContain("Output:");
    // Must still indicate truncation
    expect(output).toMatch(/\.\.\. \(\d+ more lines/);
    // Must NOT show a dangling "big:" key with no value followed by truncation marker
    expect(output).not.toMatch(/  big:\n  \.\.\./);
    // Should use the "too large to preview" placeholder
    expect(output).toContain("output too large to preview");
  });

  it("surfaces prompt, expected schema, and deliver command for an awaiting Signal Node", async () => {
    const run: RunState = {
      runId: "run-sig",
      workflowName: "demo",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:59:00.000Z",
      updatedAt: "2026-06-10T10:00:00.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/gate",
          nodeId: "gate",
          kind: "run.signal",
          state: "awaiting",
          attempt: 1,
          startedAt: "2026-06-10T09:59:00.000Z",
          renderedPrompt: "Decide on: release readiness."
        }
      ]
    };
    const ir = {
      irVersion: 1,
      astVersion: 1,
      source: { digest: "d" },
      name: "demo",
      input: {},
      agents: {},
      outputs: {},
      expressions: [],
      root: {
        id: "workflow",
        kind: "pipeline",
        nodePath: [],
        keyTemplate: "workflow",
        metadata: {},
        children: [
          {
            id: "gate",
            kind: "run.signal",
            nodePath: ["gate"],
            keyTemplate: "workflow/gate",
            metadata: {
              prompt: "Decide on: ${{ input.topic }}.",
              output: {
                type: "object",
                properties: { decision: { type: "string" }, confidence: { type: "number" } },
                required: ["decision"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    } as unknown as Parameters<typeof formatRunShow>[3];

    const output = await formatRunShow(run, undefined, Date.now(), ir);
    // Rendered prompt (not the raw template) is shown.
    expect(output).toContain("Prompt:");
    expect(output).toContain("Decide on: release readiness.");
    expect(output).not.toContain("${{");
    // Expected payload schema fields with type and requiredness.
    expect(output).toContain("Expected payload:");
    expect(output).toContain("decision: string (required)");
    expect(output).toContain("confidence: number (optional)");
    // Copy-pasteable deliver command.
    expect(output).toContain("acpus runs signal run-sig --node workflow/gate --payload");
  });

  it("shows 'any JSON object' for an awaiting Signal Node without an output schema", async () => {
    const run: RunState = {
      runId: "run-sig2",
      workflowName: "demo",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:59:00.000Z",
      updatedAt: "2026-06-10T10:00:00.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/gate",
          nodeId: "gate",
          kind: "run.signal",
          state: "awaiting",
          attempt: 1,
          startedAt: "2026-06-10T09:59:00.000Z",
          renderedPrompt: "Any object is fine."
        }
      ]
    };
    const ir = {
      irVersion: 1,
      astVersion: 1,
      source: { digest: "d" },
      name: "demo",
      input: {},
      agents: {},
      outputs: {},
      expressions: [],
      root: {
        id: "workflow",
        kind: "pipeline",
        nodePath: [],
        keyTemplate: "workflow",
        metadata: {},
        children: [
          {
            id: "gate",
            kind: "run.signal",
            nodePath: ["gate"],
            keyTemplate: "workflow/gate",
            metadata: { prompt: "Any object is fine." }
          }
        ]
      }
    } as unknown as Parameters<typeof formatRunShow>[3];

    const output = await formatRunShow(run, undefined, Date.now(), ir);
    expect(output).toContain("Expected payload: any JSON object (no schema declared)");
  });

  it("indexes a Signal Node nested inside a switch branch (composite traversal)", async () => {
    const run: RunState = {
      runId: "run-sig3",
      workflowName: "demo",
      status: "running",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:59:00.000Z",
      updatedAt: "2026-06-10T10:00:00.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/route/case:0/gate",
          nodeId: "gate",
          kind: "run.signal",
          state: "awaiting",
          attempt: 1,
          startedAt: "2026-06-10T09:59:00.000Z",
          renderedPrompt: "Nested decision."
        }
      ]
    };
    const ir = {
      irVersion: 1,
      astVersion: 1,
      source: { digest: "d" },
      name: "demo",
      input: {},
      agents: {},
      outputs: {},
      expressions: [],
      root: {
        id: "workflow",
        kind: "pipeline",
        nodePath: [],
        keyTemplate: "workflow",
        metadata: {},
        children: [
          {
            id: "route",
            kind: "switch",
            nodePath: ["route"],
            keyTemplate: "workflow/route",
            metadata: {},
            branches: [
              {
                id: "case-0",
                children: [
                  {
                    id: "gate",
                    kind: "run.signal",
                    nodePath: ["route", "gate"],
                    keyTemplate: "workflow/route/gate",
                    metadata: {
                      prompt: "Nested decision.",
                      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    } as unknown as Parameters<typeof formatRunShow>[3];

    const output = await formatRunShow(run, undefined, Date.now(), ir);
    // The signal node lives in a switch branch; its schema must still be found.
    expect(output).toContain("Expected payload:");
    expect(output).toContain("ok: boolean (required)");
  });
});
