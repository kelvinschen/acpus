import { describe, expect, it, vi } from "vitest";
import { followRun } from "../../src/follow.js";
import { formatObservation, formatTerminalSummary, type ObservationEvent } from "../../src/observations.js";
import type { RunState, AgentTelemetry } from "@acpus/runtime";

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

  it("emits only nodes visible by runs-show container filtering", async () => {
    const run: RunState = {
      runId: "run-visible",
      workflowName: "visible-workflow",
      status: "completed",
      irDigest: "sha256:ir",
      inputDigest: "sha256:input",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      runAttempt: 1,
      nodes: []
    };
    const nodes: NonNullable<RunState["nodes"]> = [
      { nodeKey: "workflow", nodeId: "workflow", kind: "pipeline", state: "completed", attempt: 1 },
      { nodeKey: "workflow/running", nodeId: "running", kind: "loop", state: "running", attempt: 1 },
      { nodeKey: "workflow/check", nodeId: "check", kind: "guard", state: "completed", attempt: 1 },
      { nodeKey: "workflow/build", nodeId: "build", kind: "run.program", state: "completed", attempt: 1 }
    ];
    const client = {
      clientKind: undefined,
      getRun: vi.fn(async () => run),
      getNodeStates: vi.fn(async () => nodes)
    };
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    });

    try {
      await expect(followRun(client as any, "run-visible", { intervalMs: 1 })).resolves.toBe("completed");
    } finally {
      write.mockRestore();
    }

    expect(output).not.toContain("workflow  [pipeline]");
    expect(output).toContain("workflow/running  [loop]  running");
    expect(output).toContain("workflow/check  [guard]");
    expect(output).toContain("workflow/build  [program]");
  });
});

describe("formatObservation", () => {
  describe("human-readable node format", () => {
    it("formats a completed agent node aligned with runs-show", () => {
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/review",
        state: "completed",
        kind: "run.agent",
        startedAt: "2026-06-10T09:00:00.000Z",
        completedAt: "2026-06-10T09:02:30.000Z",
        attempt: 1,
      };
      const output = formatObservation(event);
      // Glyph + nodeKey + [kind] + duration (no "completed" text, no "running...")
      expect(output).toMatch(/^  ✓ workflow\/review  \[agent\]  \d+m\d+s$/);
      // Should NOT show state text "completed"
      expect(output).not.toContain("completed");
    });

    it("formats a running agent node with state text and activity", () => {
      const agentTelemetry: AgentTelemetry = {
        currentAttempt: 1,
        attempts: [{
          attempt: 1,
          state: "running",
          startedAt: "2026-06-10T09:00:00.000Z",
          updatedAt: "2026-06-10T09:00:10.000Z",
          tools: {
            totalToolCallCount: 3,
            droppedToolCallCount: 0,
            recentCalls: [
              { toolCallId: "a", title: "Read", status: "completed", startedAt: "2026-06-10T09:00:05.000Z", updatedAt: "2026-06-10T09:00:05.000Z" },
            ]
          }
        }]
      };
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/review",
        state: "running",
        kind: "run.agent",
        startedAt: "2026-06-10T09:00:00.000Z",
        attempt: 1,
        agentTelemetry,
      };
      const output = formatObservation(event);
      // Should show running state text
      expect(output).toContain("⠋ workflow/review  [agent]  running");
      // Should have Activity line
      expect(output).toContain("Activity:");
      expect(output).toContain("tool_calls=3");
    });

    it("formats a failed node with error on indented line", () => {
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/build",
        state: "failed",
        kind: "run.program",
        startedAt: "2026-06-10T09:00:00.000Z",
        completedAt: "2026-06-10T09:00:05.000Z",
        error: "exit code 1",
        attempt: 1,
      };
      const output = formatObservation(event);
      expect(output).toContain("◆ workflow/build  [program]  failed");
      expect(output).toContain("    Error: exit code 1");
    });

    it("shows artifact count for failed nodes", () => {
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/build",
        state: "failed",
        kind: "run.program",
        startedAt: "2026-06-10T09:00:00.000Z",
        completedAt: "2026-06-10T09:00:05.000Z",
        error: "exit code 1",
        attempt: 1,
        artifactRefs: ["a.md", "b.md"],
      };
      const output = formatObservation(event);
      expect(output).toContain("    Artifacts: 2 files");
    });

    it("shows attempt when > 1", () => {
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/review",
        state: "completed",
        kind: "run.agent",
        startedAt: "2026-06-10T09:00:00.000Z",
        completedAt: "2026-06-10T09:02:30.000Z",
        attempt: 3,
      };
      const output = formatObservation(event);
      expect(output).toContain("attempt=3");
    });

    it("omits attempt when = 1", () => {
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/review",
        state: "completed",
        kind: "run.agent",
        startedAt: "2026-06-10T09:00:00.000Z",
        completedAt: "2026-06-10T09:02:30.000Z",
        attempt: 1,
      };
      const output = formatObservation(event);
      expect(output).not.toContain("attempt=1");
    });

    it("uses <1s for sub-second durations", () => {
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/fast",
        state: "completed",
        kind: "run.program",
        startedAt: "2026-06-10T09:00:00.000Z",
        completedAt: "2026-06-10T09:00:00.200Z",
        attempt: 1,
      };
      const output = formatObservation(event);
      expect(output).toContain("<1s");
    });

    it("formats pending node with state text", () => {
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/wait",
        state: "pending",
        kind: "run.signal",
        attempt: 0,
      };
      const output = formatObservation(event);
      expect(output).toContain("○ workflow/wait  [signal]  pending");
    });
  });

  describe("JSON mode", () => {
    it("includes kind and attempt in node events", () => {
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/review",
        state: "completed",
        kind: "run.agent",
        startedAt: "2026-06-10T09:00:00.000Z",
        completedAt: "2026-06-10T09:02:30.000Z",
        attempt: 1,
        output: { verdict: "pass" },
      };
      const json = formatObservation(event, undefined, true);
      const parsed = JSON.parse(json);
      expect(parsed.kind).toBe("run.agent");
      expect(parsed.attempt).toBe(1);
      expect(parsed.output).toEqual({ verdict: "pass" });
    });

    it("includes workflowName and createdAt in run events", () => {
      const event: ObservationEvent = {
        type: "run",
        runId: "run-1",
        status: "running",
        workflowName: "demo",
        workflowRef: "demo@v1",
        createdAt: "2026-06-10T09:00:00.000Z",
      };
      const json = formatObservation(event, "demo", true);
      const parsed = JSON.parse(json);
      expect(parsed.workflowName).toBe("demo");
      expect(parsed.workflowRef).toBe("demo@v1");
      expect(parsed.createdAt).toBe("2026-06-10T09:00:00.000Z");
    });

    it("includes agentTelemetry in node events when present", () => {
      const telemetry: AgentTelemetry = {
        currentAttempt: 1,
        attempts: [{
          attempt: 1,
          state: "running",
          startedAt: "2026-06-10T09:00:00.000Z",
          updatedAt: "2026-06-10T09:00:10.000Z",
          tools: { totalToolCallCount: 2, droppedToolCallCount: 0, recentCalls: [] }
        }]
      };
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/review",
        state: "running",
        kind: "run.agent",
        startedAt: "2026-06-10T09:00:00.000Z",
        attempt: 1,
        agentTelemetry: telemetry,
      };
      const json = formatObservation(event, undefined, true);
      const parsed = JSON.parse(json);
      expect(parsed.agentTelemetry).toBeDefined();
      expect(parsed.agentTelemetry.currentAttempt).toBe(1);
    });

    it("includes artifactRefs in node events when present", () => {
      const event: ObservationEvent = {
        type: "node",
        nodeKey: "workflow/build",
        state: "failed",
        kind: "run.program",
        startedAt: "2026-06-10T09:00:00.000Z",
        completedAt: "2026-06-10T09:00:05.000Z",
        error: "exit 1",
        attempt: 1,
        artifactRefs: ["a.md", "b.md"],
      };
      const json = formatObservation(event, undefined, true);
      const parsed = JSON.parse(json);
      expect(parsed.artifactRefs).toEqual(["a.md", "b.md"]);
    });
  });

  describe("terminal summary", () => {
    it("uses runs-show header format with duration", () => {
      const summary = formatTerminalSummary("run-1", "completed", "demo", false, {
        runDuration: 150_000, // 2m30s
        output: { verdict: "pass" },
      });
      expect(summary).toContain("✓ Run run-1 demo completed");
      expect(summary).toContain("2m30s");
    });

    it("includes runDuration and output in JSON summary", () => {
      const summary = formatTerminalSummary("run-1", "completed", "demo", true, {
        runDuration: 150_000,
        output: { verdict: "pass" },
      });
      const parsed = JSON.parse(summary);
      expect(parsed.type).toBe("summary");
      expect(parsed.runDuration).toBe(150_000);
      expect(parsed.output).toEqual({ verdict: "pass" });
    });

    it("omits output in JSON summary for failed runs", () => {
      const summary = formatTerminalSummary("run-1", "failed", "demo", true, {
        runDuration: 30_000,
      });
      const parsed = JSON.parse(summary);
      expect(parsed.type).toBe("summary");
      expect(parsed.runDuration).toBe(30_000);
      expect(parsed.output).toBeUndefined();
    });
  });
});
