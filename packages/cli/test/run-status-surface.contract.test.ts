import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type { RunDetails } from "@acpus/runtime";
import { formatRunStatusSurface, staticNodesForWorkflow } from "../src/run-status-surface.js";

describe("run status surface", () => {
  it("renders compact completed runs with node rows and pretty JSON output", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_1", "cli-valid", "completed"),
      output: { ready: true },
      dynamic: {
        version: 1,
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
        frames: [],
        nodeInstances: [{
          nodeKey: "approve~abc",
          nodeId: "approve",
          status: "awaiting",
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:00.000Z",
        }],
        attempts: [],
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
      run: { kind: "signal_run", prompt: { kind: "template", parts: [{ kind: "text", value: "approve" }] } },
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
    }, staticNodes([{ id: "review", kind: "agent", run: { kind: "agent_run", agent: "reviewer", prompt: { kind: "template", parts: [] } } }]), Date.parse("2026-07-03T00:00:02.000Z"));

    expect(output).toContain("  ✓ review~abc  [agent]  1s");
    expect(output).not.toContain("artifacts/review/attempt-1/prompt.md");
  });

  it("does not show unmaterialized branch nodes as pending after completion", () => {
    const output = formatRunStatusSurface({
      ...runBase("run_if", "branching", "completed"),
      dynamic: {
        version: 1,
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
});

function runBase(id: string, name: string, status: RunDetails["status"]): RunDetails {
  return {
    id,
    name,
    status,
    workflowEntry: "workflow.ts",
    irDigest: "sha256:ir",
    sourceGraphDigest: "sha256:graph",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:01.000Z",
    input: {},
    eventCount: 1,
    nodeCount: 1,
  };
}

function workflow(nodes: WorkflowIR["root"]["nodes"]): WorkflowIR {
  return {
    irVersion: 2,
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
