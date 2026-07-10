import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type { RunDetails } from "@acpus/runtime";
import { formatRunStatusSurface, staticNodesForWorkflow } from "../src/run-status-surface.js";

describe("run status surface", () => {
  it("indexes nested static nodes in structural pre-order", () => {
    const nodes = staticNodes([{
      id: "choose",
      kind: "if",
      condition: { kind: "literal", value: true },
      then: { nodes: [taskNode("then_task")] },
      else: { nodes: [taskNode("else_task")] },
    }, taskNode("after")]);

    expect(nodes.map(({ nodeId, kind, order }) => ({ nodeId, kind, order }))).toEqual([
      { nodeId: "choose", kind: "if", order: 0 },
      { nodeId: "then_task", kind: "task", order: 1 },
      { nodeId: "else_task", kind: "task", order: 2 },
      { nodeId: "after", kind: "task", order: 3 },
    ]);
  });

  it("renders compact completed runs with node rows and pretty JSON output", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_1", "cli-valid", "completed"),
      output: { ready: true },
      dynamic: {
        version: 1,
        progressVersion: 0,
        progress: [],
        frames: [{
          frameKey: "require_ready~abc",
          parentFrameKey: "root",
          nodeKey: "require_ready~abc",
          nodeId: "require_ready",
          frameKind: "node",
          status: "completed",
          terminalReason: "assert_passed",
          result: {},
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:00.100Z",
        }],
        nodeInstances: [],
        attempts: [],
        groups: [],
        groupMembers: [],
        signalWaits: [],
        executionMetadata: [],
      },
    }, staticNodes([{ id: "require_ready", kind: "assert", condition: { kind: "literal", value: true } }]), Date.parse("2026-07-03T00:00:01.000Z"));

    expect(output).toContain("Run run_1  cli-valid  completed  1s");
    expect(output).toContain("  ✓ require_ready~abc  [assert]  <1s");
    expect(output).toContain("Output:\n  {\n    \"ready\": true\n  }");
  });

  it("renders awaiting signal prompt, payload guidance, and command", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_sig", "cli-signal", "awaiting"),
      dynamic: {
        version: 1,
        progressVersion: 0,
        progress: [],
        frames: [],
        nodeInstances: [{
          nodeKey: "approve~abc",
          nodeId: "approve",
          status: "awaiting",
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:00.000Z",
        }],
        attempts: [],
        groups: [],
        groupMembers: [],
        signalWaits: [{
          nodeKey: "approve~abc",
          nodeId: "approve",
          status: "awaiting",
          renderedPrompt: "approve",
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:00.000Z",
        }],
        executionMetadata: [],
      },
    }, staticNodes([{
      id: "approve",
      kind: "signal",
      outputSchema: { kind: "object", fields: { ok: { kind: "boolean" } }, required: ["ok"], additionalProperties: false },
      run: { kind: "signal_run", prompt: { kind: "literal", value: "approve" } },
    }]), Date.parse("2026-07-03T00:00:01.000Z"));

    expect(output).toContain("  ◌ approve~abc  [signal]  awaiting  1s");
    expect(output).toContain("Prompt:\n      approve");
    expect(output).toContain("Expected payload:\n      ok: boolean (required)");
    expect(output).toContain("Signal: acpus runs signal run_sig --target approve~abc --payload '<json>'");
  });

  it("does not inline agent execution metadata artifact paths", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_agent", "agent-run", "completed"),
      dynamic: {
        version: 1,
        progressVersion: 0,
        progress: [],
        frames: [],
        nodeInstances: [{
          nodeKey: "review~abc",
          nodeId: "review",
          status: "completed",
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:01.000Z",
        }],
        attempts: [{
          attemptId: "attempt_1",
          nodeKey: "review~abc",
          nodeId: "review",
          attemptNo: 1,
          status: "completed",
          startedAt: "2026-07-03T00:00:00.000Z",
          finishedAt: "2026-07-03T00:00:01.000Z",
        }],
        groups: [],
        groupMembers: [],
        signalWaits: [],
        executionMetadata: [{
          id: 1,
          attemptId: "attempt_1",
          kind: "agent_attempt",
          createdAt: "2026-07-03T00:00:01.000Z",
          metadata: { promptArtifact: { relativePath: "artifacts/review/attempt-1/prompt.md" } },
        }],
      },
    }, staticNodes([{ id: "review", kind: "agent", run: { kind: "agent_run", agent: "reviewer", prompt: { kind: "literal", value: "" } } }]), Date.parse("2026-07-03T00:00:02.000Z"));

    expect(output).toContain("  ✓ review~abc  [agent]  1s");
    expect(output).not.toContain("artifacts/review/attempt-1/prompt.md");
  });

  it("renders compact agent progress telemetry", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_agent_progress", "agent-run", "completed"),
      dynamic: {
        version: 1,
        progressVersion: 1,
        progress: [{
          nodeKey: "review~abc",
          nodeId: "review",
          attemptId: "attempt_1",
          attemptNo: 1,
          kind: "agent",
          status: "completed",
          message: "turn 1 completed",
          context: { used: 999, size: 3_000 },
          tokenUsage: { inputTokens: 10, outputTokens: 2_000, totalTokens: 2_010 },
          tools: {
            totalToolCallCount: 4,
            lastCalls: [
              { title: "omitted", status: "completed" },
              { toolName: "Read", status: "completed" },
              { title: "Shell", inputPreview: "{\"command\":\"pnpm test --workspace extremely-long-suite-name --reporter verbose\"}", status: "running" },
              { toolName: "Bash", status: "completed" },
            ],
          },
          output: { tail: "line one\nline two", totalBytes: 17, truncated: false },
          updatedAt: "2026-07-03T00:00:01.000Z",
        }],
        frames: [],
        nodeInstances: [{
          nodeKey: "review~abc",
          nodeId: "review",
          status: "completed",
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:01.000Z",
        }],
        attempts: [],
        groups: [],
        groupMembers: [],
        signalWaits: [],
        executionMetadata: [],
      },
    }, staticNodes([{ id: "review", kind: "agent", run: { kind: "agent_run", agent: "reviewer", prompt: { kind: "literal", value: "" } } }]), Date.parse("2026-07-03T00:00:02.000Z"));

    expect(output).toContain([
      "  ✓ review~abc  [agent]  1s",
      "    Last active: 1s ago",
      "    Progress: turn 1 completed",
      "    Context: 999/3k",
      "    Tokens: in 10, out 2k, total 2k",
      "    Tools: 4 total; last Read, Shell, Bash",
    ].join("\n"));
    expect(output).not.toContain("Agent progress:");
    expect(output).not.toContain("omitted");
    expect(output).not.toContain("--workspace");
    expect(output).not.toContain("--reporter verbose");
    expect(output).not.toContain("Output: line one line two");
  });

  it("does not render last active for non-agent nodes", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_task", "task-run", "running"),
      dynamic: {
        version: 1,
        progressVersion: 0,
        progress: [],
        frames: [],
        nodeInstances: [{
          nodeKey: "work~abc",
          nodeId: "work",
          status: "running",
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:01.000Z",
        }],
        attempts: [],
        groups: [],
        groupMembers: [],
        signalWaits: [],
        executionMetadata: [],
      },
    }, staticNodes([{ id: "work", kind: "task", run: { kind: "task_run", input: {}, target: { kind: "inline", runtime: "node", source: "async function task() {}" } } }]), Date.parse("2026-07-03T00:00:02.000Z"));

    expect(output).toContain("work~abc  [task]  running");
    expect(output).not.toContain("Last active:");
  });

  it("does not show unmaterialized branch nodes as pending after completion", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_if", "branching", "completed"),
      dynamic: {
        version: 1,
        progressVersion: 0,
        progress: [],
        frames: [{
          frameKey: "choose~abc",
          parentFrameKey: "root",
          nodeKey: "choose~abc",
          nodeId: "choose",
          frameKind: "node",
          status: "completed",
          terminalReason: "branch_completed",
          result: { value: "then" },
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:01.000Z",
        }],
        nodeInstances: [{
          nodeKey: "then_task~abc",
          nodeId: "then_task",
          status: "completed",
          output: { value: "then" },
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:01.000Z",
        }],
        attempts: [],
        groups: [],
        groupMembers: [],
        signalWaits: [],
        executionMetadata: [],
      },
    }, staticNodes([{
      id: "choose",
      kind: "if",
      condition: { kind: "literal", value: true },
      then: { nodes: [taskNode("then_task")] },
      else: { nodes: [taskNode("else_task")] },
    }]), Date.parse("2026-07-03T00:00:02.000Z"));

    expect(output).toContain("  ✓ then_task~abc  [task]  1s");
    expect(output).not.toContain("else_task");
    expect(output).not.toContain("pending");
  });

  it("does not render stale failed attempts on retried ready nodes", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_retry", "retrying", "pending"),
      dynamic: {
        version: 1,
        progressVersion: 0,
        progress: [],
        frames: [],
        nodeInstances: [{
          nodeKey: "work~abc",
          nodeId: "work",
          status: "ready",
          statusReason: "retry",
          createdAt: "2026-07-03T00:00:10.000Z",
          updatedAt: "2026-07-03T00:00:10.000Z",
        }],
        attempts: [{
          attemptId: "attempt_failed",
          nodeKey: "work~abc",
          nodeId: "work",
          attemptNo: 1,
          status: "failed",
          startedAt: "2026-07-03T00:00:00.000Z",
          finishedAt: "2026-07-03T00:00:01.000Z",
          error: { reason: "old failure" },
        }],
        groups: [],
        groupMembers: [],
        signalWaits: [],
        executionMetadata: [],
      },
    }, staticNodes([taskNode("work")]), Date.parse("2026-07-03T00:00:11.000Z"));

    expect(output).toContain("  ○ work~abc  [task]  ready  1s");
    expect(output).not.toContain("old failure");
    expect(output).not.toContain("attempt=1");
  });

  it("prints completed workflow output without line truncation", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_output", "large-output", "completed"),
      output: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field_${index}`, index])),
    }, [], Date.parse("2026-07-03T00:00:01.000Z"));

    expect(output).toContain("\"field_29\": 29");
    expect(output).not.toContain("omitted");
  });

  it("prints hook history only for terminal runs with hooks", () => {
    const completed = formatRunStatusSurface({
      ...runBase("run_hooks", "hooked", "completed"),
      hooks: [{
        runId: "run_hooks",
        eventSequence: 42,
        triggerOrder: 1,
        event: "run.completed",
        source: "project",
        sourcePath: "/workspace/.acpus/hooks.json",
        handlerId: "notify",
        definitionHash: "hash",
        status: "completed",
        exitCode: 0,
        durationMs: 120,
        triggeredAt: "2026-07-03T00:00:01.000Z",
      }],
    }, [], Date.parse("2026-07-03T00:00:01.000Z"));

    expect(completed).toContain("Hooks:");
    expect(completed).toContain("completed  notify  run.completed  #42  120ms  exit=0");

    const running = formatRunStatusSurface({
      ...runBase("run_running_hooks", "hooked", "running"),
      hooks: [{
        runId: "run_running_hooks",
        eventSequence: 42,
        triggerOrder: 1,
        event: "run.completed",
        source: "project",
        sourcePath: "/workspace/.acpus/hooks.json",
        handlerId: "notify",
        definitionHash: "hash",
        status: "completed",
        triggeredAt: "2026-07-03T00:00:01.000Z",
      }],
    }, [], Date.parse("2026-07-03T00:00:01.000Z"));

    expect(running).not.toContain("Hooks:");
    expect(formatRunStatusSurface(runBase("run_no_hooks", "plain", "completed"))).not.toContain("Hooks:");
  });
});

function runBase(id: string, name: string, status: RunDetails["status"]): RunDetails {
  return {
    id,
    name,
    status,
    workflowEntry: "workflow.ts",
    sourceGraphDigest: "sha256:graph",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:01.000Z",
    progressVersion: 0,
    input: {},
    hooks: [],
    eventCount: 1,
    nodeCount: 1,
    execution: status === "completed" || status === "failed" || status === "canceled"
      ? { state: "terminal", lastStatus: status }
      : { state: "unknown", lastStatus: status },
  };
}

function workflow(nodes: WorkflowIR["root"]["nodes"]): WorkflowIR {
  return {
    irVersion: 3,
    name: "test",
    agents: { reviewer: { kind: "agent_definition", use: "codex" } },
    root: { nodes },
    outputs: {},
    lock: { acpusCoreVersion: "0.0.0", generatedAt: "2026-07-03T00:00:00.000Z", notes: [] },
    diagnostics: [],
  };
}

function staticNodes(nodes: WorkflowIR["root"]["nodes"]): ReturnType<typeof staticNodesForWorkflow> {
  return staticNodesForWorkflow(workflow(nodes));
}

function taskNode(id: string): WorkflowIR["root"]["nodes"][number] {
  return {
    id,
    kind: "task",
    run: { kind: "task_run", input: {}, target: { kind: "inline", runtime: "node", source: "async function task() {}" } },
  };
}
