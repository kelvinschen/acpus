import type { ExprIR, ScopeIR, WorkflowIR } from "@acpus/core/ir";
import type { JsonPrimitive, JsonValue } from "@acpus/expression/ir";
import { describe, expect, it } from "vitest";
import { projectInspectionForensicsView } from "../src/inspection/forensics-projection.js";
import { resolveTargetState } from "../src/inspection/projection.js";
import type { ResolvedTargetState } from "../src/inspection/resolved-target.js";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import type { FrozenRun, RunDetails } from "../src/store/store.js";

const createdAt = "2026-08-01T00:00:00.000Z";
const updatedAt = "2026-08-01T00:00:05.000Z";

describe("Forensics projection", () => {
  it("treats prototype-named Agent definitions and overrides as own properties", () => {
    const profile = { kind: "agent_definition" as const, use: "codex" };
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "prototype-agent",
      agents: Object.fromEntries([["__proto__", profile]]),
      root: {
        nodes: [{ id: "review", kind: "agent", run: { agent: "__proto__", prompt: literal("review") } }],
        output: literal(null),
      },
      diagnostics: [],
    };
    const frozen = frozenRun(ir);
    const run = baseRun(ir);
    const root = view(frozen, run, "root");
    const agent = view(frozen, run, "review");

    expect(root.definition.kind).toBe("workflow");
    if (root.definition.kind !== "workflow") throw new Error("Expected workflow Definition.");
    expect(Object.hasOwn(root.definition.agents, "__proto__")).toBe(true);
    expect(root.definition.agents["__proto__"]).toEqual({ profile });
    expect(agent.definition).toEqual({
      kind: "agent",
      agent: "__proto__",
      profile,
      prompt: "\"review\"",
    });

    const override = { model: "review-model" };
    const overridden = frozenRun(ir, {}, Object.fromEntries([["__proto__", override]]));
    expect(view(overridden, run, "review").definition).toEqual({
      kind: "agent",
      agent: "__proto__",
      profile,
      override,
      prompt: "\"review\"",
    });
  });

  it("projects the frozen root and every node Definition without inline Task source", () => {
    const ir = definitionWorkflow();
    const agentOverrides = {
      reviewer: {
        command: "effective-agent",
        model: "effective-model",
        config: { effort: "high" },
        permissionMode: "deny-all" as const,
        cwd: "/effective/profile",
        env: { PROFILE: "effective" },
      },
    };
    const input = { topic: "full input", nested: { keep: true } };
    const run = baseRun(ir, { input });
    const frozen = frozenRun(ir, input, agentOverrides);

    const root = view(frozen, run, "root");
    expect(root.definition).toMatchObject({
      kind: "workflow",
      name: "forensics-definitions",
      description: "Frozen workflow description",
      inputSchema: {
        kind: "object",
        fields: { topic: { kind: "string" } },
      },
      agents: {
        reviewer: {
          profile: {
            kind: "agent_command",
            command: "effective-agent",
            model: "effective-model",
            config: { effort: "high" },
            permissionMode: "deny-all",
            cwd: "/effective/profile",
            env: { PROFILE: "effective" },
          },
          override: agentOverrides.reviewer,
        },
      },
      root: {
        nodes: ["review", "inline_task", "module_task", "approval", "guard", "choose", "route", "work", "batch", "cycle"],
        output: "nodes.cycle.output",
      },
    });
    expect(root.invocation).toEqual({ status: "resolved", kind: "workflow", input });
    expect(root.result).toEqual({ status: "pending" });

    expect(view(frozen, run, "review").definition).toMatchObject({
      kind: "agent",
      agent: "reviewer",
      profile: ir.agents.reviewer,
      override: agentOverrides.reviewer,
      prompt: "`Review ${input.topic}`",
      permissionMode: "approve-reads",
      sessionKey: "input.session",
      cwd: "input.cwd",
      env: { NODE_ENV: "input.environment" },
      timeout: "\"30s\"",
      outputSchema: { kind: "object" },
    });

    const inlineTask = view(frozen, run, "inline_task");
    expect(inlineTask.definition).toMatchObject({
      kind: "task",
      input: "{ topic: input.topic }",
      implementation: "inline",
      cwd: "input.cwd",
      env: { TASK_ENV: "input.environment" },
      defaultCommandTimeout: "\"5s\"",
      timeout: "\"1m\"",
    });
    expect(JSON.stringify(inlineTask.definition)).not.toContain("INLINE_SECRET_SOURCE");
    expect(JSON.stringify(inlineTask.definition)).not.toContain("digest");
    expect(view(frozen, run, "module_task").definition).toMatchObject({
      kind: "task",
      implementation: { kind: "module", specifier: "@scope/tasks", export: "build" },
    });

    expect(view(frozen, run, "approval").definition).toMatchObject({
      kind: "signal",
      prompt: "`Approve ${input.topic}?`",
      timeout: "\"2h\"",
      onTimeoutMessage: "\"Approval expired\"",
      outputSchema: { kind: "boolean" },
    });
    expect(view(frozen, run, "guard").definition).toEqual({
      kind: "assert",
      condition: "input.ready",
      message: "\"Not ready\"",
    });
    expect(view(frozen, run, "choose").definition).toMatchObject({
      kind: "if",
      condition: "input.ready",
      branches: {
        then: { nodes: ["then_task"], output: "\"then-output\"" },
        else: { nodes: ["else_task"], output: "\"else-output\"" },
      },
    });
    expect(view(frozen, run, "route").definition).toMatchObject({
      kind: "switch",
      cases: [{ id: "case:0", when: "input.ready", then: { nodes: [], output: "\"case-output\"" } }],
      default: { nodes: [], output: "\"default-output\"" },
    });
    expect(view(frozen, run, "work").definition).toMatchObject({
      kind: "parallel",
      strategy: "race",
      maxConcurrency: "2",
      branches: {
        left: { nodes: [], output: "\"left\"" },
        right: { nodes: [], output: "\"right\"" },
      },
    });
    expect(view(frozen, run, "batch").definition).toMatchObject({
      kind: "fanout",
      over: "input.items",
      strategy: "quorum",
      count: "2",
      maxConcurrency: "3",
      do: { nodes: [], output: "fanout.item" },
    });
    expect(view(frozen, run, "cycle").definition).toEqual({
      kind: "loop",
      state: "input.initial",
      do: {
        nodes: [],
        transition: { state: "loop.state", stop: "input.stop" },
      },
    });

    for (const target of ["review", "inline_task", "module_task", "approval", "guard", "choose", "route", "work", "batch", "cycle"]) {
      expect(view(frozen, run, target).invocation).toEqual({ status: "unavailable", reason: "not_started" });
      expect(view(frozen, run, target).result).toEqual({ status: "not_started" });
    }
  });

  it("returns complete root input/output without recomputing or truncating values", () => {
    const ir = definitionWorkflow();
    const large = "x".repeat(32_000);
    const input = { large, nested: [1, { full: large }] };
    const run = baseRun(ir, { status: "completed", input, output: { large, complete: true } });
    const projected = view(frozenRun(ir, input), run, "root");

    expect(projected.state).toEqual({ status: "completed", durationMs: 5_000 });
    expect(projected.invocation).toEqual({ status: "resolved", kind: "workflow", input });
    expect(projected.result).toEqual({ status: "accepted", value: { large, complete: true } });
  });

  it("projects the first actual Agent request and its nested durable execution context", () => {
    const ir = nestedAgentWorkflow();
    const itemPath = appendFanoutItem([], "batch", 0);
    const loopPath = appendLoopIteration(itemPath, "cycle", 2);
    const branchPath = appendBranch(loopPath, "choose", "then");
    const agentPath = appendNode(branchPath, "review");
    const batchKey = deriveInstanceKey(appendNode([], "batch"));
    const cycleKey = deriveInstanceKey(appendNode(itemPath, "cycle"));
    const agentKey = deriveInstanceKey(agentPath);
    const attemptId = "attempt-agent-1";
    const prompt = `Review everything.\n${"complete".repeat(2_000)}`;
    const run = baseRun(ir, {
      dynamic: {
        frames: [{
          frameKey: cycleKey,
          nodeKey: cycleKey,
          nodeId: "cycle",
          frameKind: "loop",
          status: "running",
          instancePath: appendNode(itemPath, "cycle"),
          loop: { iter: 2, index: 2, round: 3, state: { draft: 3 }, transition: { state: { draft: 3 }, stop: false } },
          createdAt,
          updatedAt,
        }],
        nodeInstances: [{
          nodeKey: agentKey,
          nodeId: "review",
          instancePath: agentPath,
          status: "running",
          createdAt,
          updatedAt,
        }],
        attempts: [{
          attemptId,
          nodeKey: agentKey,
          nodeId: "review",
          attemptNo: 1,
          status: "started",
          startedAt: createdAt,
        }],
        groups: [],
        groupMembers: [{
          groupKey: batchKey,
          memberKey: "batch-item-0",
          memberKind: "fanout_item",
          itemIndex: 0,
          item: { ticket: 42 },
          status: "running",
          createdAt,
          updatedAt,
        }],
        signalWaits: [],
        executionMetadata: [{
          id: 1,
          attemptId,
          kind: "agent_invocation",
          metadata: {
            prompt,
            promptOrigin: "authored",
            cwd: "/workspace/review",
            env: { PROFILE: "one", NODE: "two" },
            model: "gpt-forensics",
            permissionMode: "deny-all",
            sessionKey: "shared-review",
            config: { effort: "high" },
            deadlineAt: "2026-08-01T01:00:00.000Z",
            hostEnv: { HOST_SECRET: "must-not-leak" },
            providerIdentity: "must-not-leak",
          },
          createdAt,
        }],
        progress: [{
          nodeKey: agentKey,
          nodeId: "review",
          attemptId,
          attemptNo: 1,
          kind: "agent",
          status: "running",
          output: { tail: "partial response must-not-leak", totalBytes: 30, truncated: false },
          tools: { calls: ["must-not-leak"] },
          updatedAt,
        }],
      },
    });

    const projected = view(frozenRun(ir), run, agentKey);
    expect(projected.invocation).toEqual({
      status: "resolved",
      kind: "agent",
      attempt: 1,
      promptOrigin: "authored",
      prompt,
      cwd: "/workspace/review",
      env: { PROFILE: "one", NODE: "two" },
      model: "gpt-forensics",
      permissionMode: "deny-all",
      sessionKey: "shared-review",
      config: { effort: "high" },
      deadlineAt: "2026-08-01T01:00:00.000Z",
      context: [
        { kind: "fanout", nodeId: "batch", itemIndex: 0, item: { ticket: 42 } },
        { kind: "loop", nodeId: "cycle", index: 2, round: 3, state: { draft: 3 } },
        { kind: "branch", nodeId: "choose", ownerKind: "if", branchId: "then" },
      ],
    });
    expect(projected.result).toEqual({ status: "pending" });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("HOST_SECRET");
    expect(serialized).not.toContain("providerIdentity");
    expect(serialized).not.toContain("partial response");
    expect(serialized).not.toContain("tools");
  });

  it("uses the latest occurrence invocation but exposes output only from the accepted attempt", () => {
    const ir = taskWorkflow();
    const nodePath = appendNode([], "work");
    const nodeKey = deriveInstanceKey(nodePath);
    const acceptedOutput = { value: "accepted", large: "y".repeat(16_000) };
    const run = baseRun(ir, {
      status: "completed",
      output: acceptedOutput,
      dynamic: {
        frames: [],
        nodeInstances: [{
          nodeKey,
          nodeId: "work",
          instancePath: nodePath,
          status: "completed",
          output: acceptedOutput,
          acceptedAttemptId: "attempt-2",
          createdAt,
          updatedAt,
        }],
        attempts: [{
          attemptId: "attempt-1",
          nodeKey,
          nodeId: "work",
          attemptNo: 1,
          status: "completed",
          result: { candidate: "must-not-leak" },
          startedAt: createdAt,
          finishedAt: "2026-08-01T00:00:02.000Z",
        }, {
          attemptId: "attempt-2",
          nodeKey,
          nodeId: "work",
          attemptNo: 2,
          status: "completed",
          result: acceptedOutput,
          startedAt: "2026-08-01T00:00:03.000Z",
          finishedAt: updatedAt,
        }],
        groups: [],
        groupMembers: [],
        signalWaits: [],
        executionMetadata: [{
          id: 1,
          attemptId: "attempt-1",
          kind: "task_attempt",
          metadata: { input: { revision: 1 }, cwd: "/workspace/one", env: { REVISION: "1" }, timeoutMs: 1_000 },
          createdAt,
        }, {
          id: 2,
          attemptId: "attempt-2",
          kind: "task_attempt",
          metadata: { input: { revision: 2 }, cwd: "/workspace/two", env: { REVISION: "2" }, timeoutMs: 2_000 },
          createdAt: "2026-08-01T00:00:03.000Z",
        }, {
          id: 3,
          attemptId: "attempt-2",
          kind: "provider_final_response",
          metadata: { candidate: "must-not-leak" },
          createdAt: updatedAt,
        }],
        progress: [],
      },
    });
    const frozen = frozenRun(ir);

    expect(view(frozen, run, nodeKey).invocation).toMatchObject({
      status: "resolved",
      kind: "task",
      attempt: 2,
      input: { revision: 2 },
      cwd: "/workspace/two",
      env: { REVISION: "2" },
      timeoutMs: 2_000,
    });
    expect(view(frozen, run, nodeKey).result).toEqual({ status: "accepted", value: acceptedOutput });
    expect(view(frozen, run, "attempt-1").invocation).toMatchObject({ attempt: 1, input: { revision: 1 } });
    const rejected = view(frozen, run, "attempt-1").result;
    expect(rejected).toEqual({ status: "not_accepted" });
    expect(JSON.stringify(rejected)).not.toContain("must-not-leak");
    expect(view(frozen, run, "attempt-2").result).toEqual({ status: "accepted", value: acceptedOutput });

    const retrying = structuredClone(run);
    retrying.status = "running";
    retrying.dynamic!.nodeInstances[0]!.status = "ready";
    delete retrying.dynamic!.nodeInstances[0]!.output;
    delete retrying.dynamic!.nodeInstances[0]!.acceptedAttemptId;
    retrying.dynamic!.attempts.push({
      attemptId: "attempt-3",
      nodeKey,
      nodeId: "work",
      attemptNo: 3,
      status: "superseded",
      startedAt: updatedAt,
      finishedAt: updatedAt,
    });
    retrying.dynamic!.executionMetadata.push({
      id: 4,
      attemptId: "attempt-3",
      kind: "task_attempt",
      metadata: { input: { revision: 3 }, cwd: "/workspace/three", env: { REVISION: "3" } },
      createdAt: updatedAt,
    });
    expect(view(frozen, retrying, nodeKey)).toMatchObject({
      state: { status: "ready" },
      invocation: { status: "resolved", kind: "task", attempt: 3 },
      result: { status: "pending" },
    });
    expect(view(frozen, retrying, "attempt-3")).toMatchObject({
      state: { status: "cancelled" },
      result: { status: "not_accepted" },
    });

    retrying.dynamic!.executionMetadata = retrying.dynamic!.executionMetadata.filter(metadata => metadata.attemptId !== "attempt-3");
    expect(view(frozen, retrying, nodeKey).invocation).toEqual({ status: "unavailable", reason: "not_yet_resolved" });

    run.dynamic!.executionMetadata = [{
      id: 4,
      attemptId: "attempt-2",
      kind: "task_attempt",
      metadata: { input: { revision: 2 }, cwd: "/workspace/two" },
      createdAt: updatedAt,
    }];
    expect(view(frozen, run, nodeKey).invocation).toEqual({ status: "unavailable", reason: "not_recorded" });
    run.dynamic!.nodeInstances[0]!.output = undefined;
    delete run.output;
    expect(view(frozen, run, nodeKey).result).toEqual({ status: "completed_without_output" });
  });

  it("projects Signal, Assert, branch, Parallel, Fanout, and Loop invocation from durable state", () => {
    const ir = durableCompositeWorkflow();
    const signalPath = appendNode([], "approval");
    const assertPath = appendNode([], "guard");
    const ifPath = appendNode([], "choose");
    const ifBranchPath = appendBranch([], "choose", "then");
    const switchPath = appendNode([], "route");
    const switchBranchPath = appendBranch([], "route", "default");
    const parallelPath = appendNode([], "work");
    const fanoutPath = appendNode([], "batch");
    const loopPath = appendNode([], "cycle");
    const keys = Object.fromEntries(Object.entries({
      signalPath,
      assertPath,
      ifPath,
      switchPath,
      parallelPath,
      fanoutPath,
      loopPath,
    }).map(([name, path]) => [name.replace("Path", ""), deriveInstanceKey(path)]));
    const run = baseRun(ir, {
      dynamic: {
        frames: [{
          frameKey: keys.assert!, nodeKey: keys.assert!, nodeId: "guard", frameKind: "node", status: "failed",
          instancePath: assertPath, terminalReason: "assert_failed",
          error: { code: "ASSERT", message: "Guard rejected.", private: "must-not-leak" }, createdAt, updatedAt,
        }, {
          frameKey: keys.if!, nodeKey: keys.if!, nodeId: "choose", frameKind: "node", status: "completed",
          instancePath: ifPath, result: { selected: "then" }, createdAt, updatedAt,
        }, {
          frameKey: deriveInstanceKey(ifBranchPath), nodeId: "choose", frameKind: "branch", status: "completed",
          parentFrameKey: keys.if!, instancePath: ifBranchPath, result: { selected: "then" }, createdAt, updatedAt,
        }, {
          frameKey: keys.switch!, nodeKey: keys.switch!, nodeId: "route", frameKind: "node", status: "running",
          instancePath: switchPath, createdAt, updatedAt,
        }, {
          frameKey: deriveInstanceKey(switchBranchPath), nodeId: "route", frameKind: "branch", status: "running",
          parentFrameKey: keys.switch!, instancePath: switchBranchPath, createdAt, updatedAt,
        }, {
          frameKey: keys.parallel!, nodeKey: keys.parallel!, nodeId: "work", frameKind: "node", status: "completed",
          instancePath: parallelPath, result: { winner: "left" }, createdAt, updatedAt,
        }, {
          frameKey: keys.fanout!, nodeKey: keys.fanout!, nodeId: "batch", frameKind: "node", status: "running",
          instancePath: fanoutPath, createdAt, updatedAt,
        }, {
          frameKey: keys.loop!, nodeKey: keys.loop!, nodeId: "cycle", frameKind: "loop", status: "completed",
          instancePath: loopPath, result: { count: 4 },
          loop: { iter: 3, index: 3, round: 4, state: { count: 4 }, transition: { state: { count: 4 }, stop: true } },
          createdAt, updatedAt,
        }],
        nodeInstances: [{
          nodeKey: keys.signal!, nodeId: "approval", instancePath: signalPath, status: "awaiting", createdAt, updatedAt,
        }],
        attempts: [],
        groups: [{
          groupKey: keys.parallel!, nodeKey: keys.parallel!, nodeId: "work", kind: "parallel", strategy: "race", status: "completed", maxConcurrency: 2,
        }, {
          groupKey: keys.fanout!, nodeKey: keys.fanout!, nodeId: "batch", kind: "fanout", strategy: "quorum", status: "running", quorumCount: 2, maxConcurrency: 3,
        }],
        groupMembers: [{
          groupKey: keys.fanout!, memberKey: "item-1", memberKind: "fanout_item", itemIndex: 1, item: { id: 2 }, status: "running", createdAt, updatedAt,
        }, {
          groupKey: keys.fanout!, memberKey: "item-0", memberKind: "fanout_item", itemIndex: 0, item: { id: 1 }, status: "completed", createdAt, updatedAt,
        }],
        signalWaits: [{
          nodeKey: keys.signal!, nodeId: "approval", status: "awaiting", renderedPrompt: "Approve the frozen plan?",
          deadlineAt: "2026-08-01T02:00:00.000Z", createdAt, updatedAt,
        }],
        executionMetadata: [],
        progress: [],
      },
    });
    const frozen = frozenRun(ir);

    expect(view(frozen, run, keys.signal!).invocation).toEqual({
      status: "resolved", kind: "signal", prompt: "Approve the frozen plan?", deadlineAt: "2026-08-01T02:00:00.000Z",
    });
    expect(view(frozen, run, keys.signal!).result).toEqual({ status: "pending" });
    expect(view(frozen, run, keys.assert!).invocation).toEqual({ status: "resolved", kind: "assert", condition: false });
    expect(view(frozen, run, keys.assert!).result).toEqual({
      status: "failed", code: "ASSERT", message: "Guard rejected.",
    });
    expect(JSON.stringify(view(frozen, run, keys.assert!).result)).not.toContain("private");
    const passedAssert = structuredClone(run);
    const passedAssertFrame = passedAssert.dynamic!.frames.find(frame => frame.frameKey === keys.assert);
    if (!passedAssertFrame) throw new Error("Expected durable Assert frame.");
    passedAssertFrame.status = "completed";
    passedAssertFrame.terminalReason = "assert_passed";
    passedAssertFrame.result = {};
    delete passedAssertFrame.error;
    expect(view(frozen, passedAssert, keys.assert!).invocation).toEqual({ status: "resolved", kind: "assert", condition: true });
    expect(view(frozen, passedAssert, keys.assert!).result).toEqual({ status: "completed_without_output" });
    expect(view(frozen, run, keys.if!).invocation).toEqual({ status: "resolved", kind: "if", selectedBranch: "then" });
    expect(view(frozen, run, keys.if!).result).toEqual({ status: "accepted", value: { selected: "then" } });
    expect(view(frozen, run, keys.switch!).invocation).toEqual({ status: "resolved", kind: "switch", selectedBranch: "default" });
    expect(view(frozen, run, keys.parallel!).invocation).toEqual({ status: "resolved", kind: "parallel", maxConcurrency: 2 });
    expect(view(frozen, run, keys.parallel!).result).toEqual({ status: "accepted", value: { winner: "left" } });
    expect(view(frozen, run, keys.fanout!).invocation).toEqual({
      status: "resolved", kind: "fanout", items: [{ id: 1 }, { id: 2 }], quorumCount: 2, maxConcurrency: 3,
    });
    expect(view(frozen, run, keys.loop!).invocation).toEqual({
      status: "resolved", kind: "loop", index: 3, round: 4, state: { count: 4 }, transition: { state: { count: 4 }, stop: true },
    });
    expect(view(frozen, run, keys.loop!).result).toEqual({ status: "accepted", value: { count: 4 } });
  });

  it("distinguishes resolution failure, timeout, cancellation, and unselected work", () => {
    const ir = failureWorkflow();
    const failedPath = appendNode([], "choose");
    const timedPath = appendNode([], "timed");
    const cancelledPath = appendNode([], "cancelled");
    const elsePath = appendBranch([], "branch", "else");
    const keys = {
      failed: deriveInstanceKey(failedPath),
      timed: deriveInstanceKey(timedPath),
      cancelled: deriveInstanceKey(cancelledPath),
      branch: deriveInstanceKey(appendNode([], "branch")),
    };
    const run = baseRun(ir, {
      status: "failed",
      dynamic: {
        frames: [{
          frameKey: keys.failed, nodeKey: keys.failed, nodeId: "choose", frameKind: "node", status: "failed",
          instancePath: failedPath, terminalReason: "expression_failed", error: { message: "Condition failed." }, createdAt, updatedAt,
        }, {
          frameKey: keys.branch, nodeKey: keys.branch, nodeId: "branch", frameKind: "node", status: "completed",
          instancePath: appendNode([], "branch"), result: null, createdAt, updatedAt,
        }, {
          frameKey: deriveInstanceKey(elsePath), nodeId: "branch", frameKind: "branch", status: "completed",
          parentFrameKey: keys.branch, instancePath: elsePath, result: null, createdAt, updatedAt,
        }],
        nodeInstances: [{
          nodeKey: keys.timed, nodeId: "timed", instancePath: timedPath, status: "failed", createdAt, updatedAt,
        }, {
          nodeKey: keys.cancelled, nodeId: "cancelled", instancePath: cancelledPath, status: "cancelled", createdAt, updatedAt,
        }],
        attempts: [{
          attemptId: "attempt-timed", nodeKey: keys.timed, nodeId: "timed", attemptNo: 1, status: "timed_out",
          error: { code: "TIMEOUT", message: "Deadline reached." }, startedAt: createdAt, finishedAt: updatedAt,
        }, {
          attemptId: "attempt-cancelled", nodeKey: keys.cancelled, nodeId: "cancelled", attemptNo: 1, status: "cancelled",
          startedAt: createdAt, finishedAt: updatedAt,
        }],
        groups: [],
        groupMembers: [],
        signalWaits: [],
        executionMetadata: [],
        progress: [],
      },
    });
    const frozen = frozenRun(ir);

    expect(view(frozen, run, keys.failed).invocation).toEqual({ status: "unavailable", reason: "resolution_failed" });
    expect(view(frozen, run, keys.timed).result).toEqual({
      status: "timed_out", code: "TIMEOUT", message: "Deadline reached.",
    });
    expect(view(frozen, run, keys.cancelled).result).toEqual({ status: "cancelled" });
    const skipped = view(frozen, run, "skipped");
    expect(skipped.state).toEqual({ status: "not_selected" });
    expect(skipped.invocation).toEqual({ status: "unavailable", reason: "not_selected" });
    expect(skipped.result).toEqual({ status: "not_selected" });
  });
});

function view(frozen: FrozenRun, run: RunDetails, target: string) {
  const details = targetState(frozen.ir, run, target);
  return projectInspectionForensicsView({ frozen, run, details });
}

function targetState(ir: WorkflowIR, run: RunDetails, target: string): ResolvedTargetState {
  const details = resolveTargetState({ ir, run, target, artifacts: [] });
  if (!details) throw new Error(`Expected target '${target}' to resolve.`);
  return details;
}

function frozenRun(
  ir: WorkflowIR,
  input: JsonValue = {},
  agentOverrides: FrozenRun["agentOverrides"] = {},
): FrozenRun {
  return {
    ir,
    input,
    agentOverrides,
    meta: { runId: "run-forensics", workflowPath: "workflow.ts", workflowName: ir.name, workspaceDir: "/workspace" },
  };
}

function baseRun(
  ir: WorkflowIR,
  options: {
    status?: RunDetails["status"];
    input?: JsonValue;
    output?: JsonValue;
    dynamic?: Partial<NonNullable<RunDetails["dynamic"]>>;
  } = {},
): RunDetails {
  return {
    id: "run-forensics",
    name: ir.name,
    status: options.status ?? "running",
    workflowEntry: "workflow.ts",
    sourceGraphDigest: "sha256:frozen",
    createdAt,
    updatedAt,
    progressVersion: 1,
    input: options.input ?? {},
    ...(options.output === undefined ? {} : { output: options.output }),
    hooks: [],
    eventCount: 1,
    nodeCount: ir.root.nodes.length,
    execution: { state: options.status === "completed" ? "terminal" : "active", lastStatus: options.status ?? "running" },
    dynamic: {
      version: 1,
      progressVersion: 1,
      frames: options.dynamic?.frames ?? [],
      nodeInstances: options.dynamic?.nodeInstances ?? [],
      attempts: options.dynamic?.attempts ?? [],
      groups: options.dynamic?.groups ?? [],
      groupMembers: options.dynamic?.groupMembers ?? [],
      signalWaits: options.dynamic?.signalWaits ?? [],
      executionMetadata: options.dynamic?.executionMetadata ?? [],
      progress: options.dynamic?.progress ?? [],
    },
  };
}

const literal = (value: JsonPrimitive): ExprIR => ({ kind: "literal", value });
const valueExpression = (value: JsonValue): ExprIR => Array.isArray(value)
  ? { kind: "array", items: value.map(valueExpression) }
  : value !== null && typeof value === "object"
    ? { kind: "object", fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valueExpression(item)])) }
    : literal(value);
const ref = (...path: string[]): ExprIR => ({ kind: "ref", path });
const emptyScope = (output: JsonValue = null): ScopeIR => ({ nodes: [], output: valueExpression(output) });
const inlineTarget = (source = "async () => undefined") => ({ kind: "inline" as const, source });

function definitionWorkflow(): WorkflowIR {
  const inlineChild = (id: string) => ({
    id,
    kind: "task" as const,
    run: { input: literal(null), target: inlineTarget() },
  });
  return {
    irVersion: 7,
    name: "forensics-definitions",
    description: "Frozen workflow description",
    inputSchema: {
      kind: "object",
      fields: { topic: { kind: "string" } },
      required: ["topic"],
      additionalProperties: true,
    },
    agents: {
      reviewer: {
        kind: "agent_command",
        command: "effective-agent",
        model: "effective-model",
        config: { effort: "high" },
        permissionMode: "deny-all",
        cwd: "/effective/profile",
        env: { PROFILE: "effective" },
      },
    },
    root: {
      nodes: [{
        id: "review",
        kind: "agent",
        run: {
          agent: "reviewer",
          prompt: { kind: "template", parts: [{ kind: "text", value: "Review " }, { kind: "expr", expr: ref("input", "topic") }] },
          permissionMode: "approve-reads",
          sessionKey: ref("input", "session"),
          cwd: ref("input", "cwd"),
          env: { NODE_ENV: ref("input", "environment") },
        },
        outputSchema: { kind: "object", fields: { ok: { kind: "boolean" } }, required: ["ok"], additionalProperties: false },
        timeout: literal("30s"),
      }, {
        id: "inline_task",
        kind: "task",
        run: {
          input: { kind: "object", fields: { topic: ref("input", "topic") } },
          target: inlineTarget("INLINE_SECRET_SOURCE"),
          cwd: ref("input", "cwd"),
          env: { TASK_ENV: ref("input", "environment") },
          execution: { defaultCommandTimeout: literal("5s") },
        },
        timeout: literal("1m"),
      }, {
        id: "module_task",
        kind: "task",
        run: {
          input: literal(null),
          target: { kind: "module", specifier: "@scope/tasks", exportName: "build", referrer: { path: "private/referrer.ts" } },
        },
      }, {
        id: "approval",
        kind: "signal",
        run: { prompt: { kind: "template", parts: [{ kind: "text", value: "Approve " }, { kind: "expr", expr: ref("input", "topic") }, { kind: "text", value: "?" }] } },
        outputSchema: { kind: "boolean" },
        timeout: literal("2h"),
        onTimeout: { message: literal("Approval expired") },
      }, {
        id: "guard", kind: "assert", condition: ref("input", "ready"), message: literal("Not ready"),
      }, {
        id: "choose", kind: "if", condition: ref("input", "ready"),
        then: { nodes: [inlineChild("then_task")], output: literal("then-output") },
        else: { nodes: [inlineChild("else_task")], output: literal("else-output") },
      }, {
        id: "route", kind: "switch",
        cases: [{ when: ref("input", "ready"), then: emptyScope("case-output") }],
        default: emptyScope("default-output"),
      }, {
        id: "work", kind: "parallel", strategy: "race", maxConcurrency: literal(2),
        branches: { left: emptyScope("left"), right: emptyScope("right") },
      }, {
        id: "batch", kind: "fanout", strategy: "quorum", over: ref("input", "items"), count: literal(2), maxConcurrency: literal(3),
        do: { nodes: [], output: ref("fanout", "item") },
      }, {
        id: "cycle", kind: "loop", state: ref("input", "initial"),
        do: { nodes: [], output: { kind: "object", fields: { state: ref("loop", "state"), stop: ref("input", "stop") } } },
      }],
      output: ref("nodes", "cycle", "output"),
    },
    diagnostics: [],
  };
}

function taskWorkflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "forensics-task",
    agents: {},
    root: {
      nodes: [{ id: "work", kind: "task", run: { input: ref("input"), target: inlineTarget("PRIVATE_TASK_SOURCE") } }],
      output: ref("nodes", "work", "output"),
    },
    diagnostics: [],
  };
}

function nestedAgentWorkflow(): WorkflowIR {
  const reviewScope: ScopeIR = {
    nodes: [{ id: "review", kind: "agent", run: { agent: "reviewer", prompt: literal("authored") } }],
    output: ref("nodes", "review", "output"),
  };
  const chooseScope: ScopeIR = {
    nodes: [{ id: "choose", kind: "if", condition: literal(true), then: reviewScope, else: emptyScope() }],
    output: ref("nodes", "choose", "output"),
  };
  return {
    irVersion: 7,
    name: "forensics-agent-context",
    agents: { reviewer: { kind: "agent_definition", use: "codex" } },
    root: {
      nodes: [{
        id: "batch", kind: "fanout", strategy: "all", over: valueExpression([{ ticket: 42 }]),
        do: {
          nodes: [{
            id: "cycle", kind: "loop", state: valueExpression({ draft: 1 }),
            do: { nodes: chooseScope.nodes, output: { kind: "object", fields: { state: ref("loop", "state"), stop: literal(false) } } },
          }],
          output: ref("nodes", "cycle", "output"),
        },
      }],
      output: ref("nodes", "batch", "output"),
    },
    diagnostics: [],
  };
}

function durableCompositeWorkflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "forensics-durable-composites",
    agents: {},
    root: {
      nodes: [{
        id: "approval", kind: "signal", run: { prompt: literal("authored prompt") },
      }, {
        id: "guard", kind: "assert", condition: literal(false), message: literal("Guard rejected."),
      }, {
        id: "choose", kind: "if", condition: literal(false), then: emptyScope(), else: emptyScope(),
      }, {
        id: "route", kind: "switch", cases: [{ when: literal(false), then: emptyScope() }], default: emptyScope(),
      }, {
        id: "work", kind: "parallel", strategy: "race", maxConcurrency: literal(99), branches: { left: emptyScope(), right: emptyScope() },
      }, {
        id: "batch", kind: "fanout", strategy: "quorum", over: valueExpression([]), count: literal(99), maxConcurrency: literal(99), do: emptyScope(),
      }, {
        id: "cycle", kind: "loop", state: valueExpression({ authored: true }),
        do: { nodes: [], output: { kind: "object", fields: { state: valueExpression({ authored: true }), stop: literal(false) } } },
      }],
      output: literal(null),
    },
    diagnostics: [],
  };
}

function failureWorkflow(): WorkflowIR {
  const skipped = { id: "skipped", kind: "task" as const, run: { input: literal(null), target: inlineTarget() } };
  return {
    irVersion: 7,
    name: "forensics-failures",
    agents: {},
    root: {
      nodes: [{ id: "choose", kind: "if", condition: ref("input", "missing"), then: emptyScope(), else: emptyScope() }, {
        id: "timed", kind: "task", run: { input: literal(null), target: inlineTarget() },
      }, {
        id: "cancelled", kind: "task", run: { input: literal(null), target: inlineTarget() },
      }, {
        id: "branch", kind: "if", condition: literal(false), then: { nodes: [skipped], output: literal(null) }, else: emptyScope(),
      }],
      output: literal(null),
    },
    diagnostics: [],
  };
}
