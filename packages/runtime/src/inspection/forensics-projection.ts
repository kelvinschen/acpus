import { walkNodes, type ExprIR, type NodeIR, type ScopeIR, type TemplateIR, type WorkflowIR } from "@acpus/core/ir";
import { isJsonValue, type JsonPrimitive } from "@acpus/expression/ir";
import { appendNode, deriveInstanceKey } from "../scheduler/identity.js";
import type { InstancePath, InstancePathSegment } from "../scheduler/types.js";
import type {
  FrozenRun,
  RunDetails,
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicNodeInstance,
} from "../store/store.js";
import { inspectionViewSubject } from "./decision-projection.js";
import type { ResolvedTargetState } from "./resolved-target.js";
import type {
  ForensicsDefinition,
  ForensicsExecutionContext,
  ForensicsInvocation,
  ForensicsResult,
  ForensicsScopeDefinition,
  InspectionView,
  RunInspectionStatus,
} from "./types.js";

export function projectInspectionForensicsView(input: {
  frozen: FrozenRun;
  run: RunDetails;
  details: ResolvedTargetState;
}): Extract<InspectionView, { kind: "target"; detail: "forensics" }> {
  const root = input.details.target.id === "root";
  const selected = selectedTarget(input.details);
  const node = root ? undefined : targetNode(input.frozen.ir, input.details);
  if (!root && !node) throw new Error("Forensics target is missing from frozen IR.");
  const context = executionContext(input.frozen.ir, input.run, selected.path);
  const status = targetStatus(input.frozen.ir, input.run, input.details, selected, node);
  const durationMs = targetDurationMs(input.run, selected, root);
  const subject = inspectionViewSubject(input.details);
  return {
    kind: "target",
    detail: "forensics",
    run: { id: input.run.id, status: input.run.status },
    subject: root ? { ...subject, selector: "root" } : subject,
    state: {
      status,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
    definition: definition(input.frozen, node),
    invocation: invocation(input.frozen, input.run, input.details, node, selected, context, status),
    result: result(input.run, input.details, selected, status, node),
  };
}

type SelectedTarget = {
  attempt?: RunDynamicAttempt;
  instance?: RunDynamicNodeInstance;
  frame?: RunDynamicFrame;
  path?: InstancePath;
};

function selectedTarget(details: ResolvedTargetState): SelectedTarget {
  const attempt = details.target.kind === "attempt"
    ? details.attempts.find(candidate => candidate.attemptId === details.target.id)
    : latestAttempt(details.attempts);
  const instance = details.target.kind === "dynamic-node"
    ? details.instances.find(candidate => candidate.nodeKey === details.target.id)
    : attempt
      ? details.instances.find(candidate => candidate.nodeKey === attempt.nodeKey)
      : details.summary.nodeKey
        ? details.instances.find(candidate => candidate.nodeKey === details.summary.nodeKey)
        : details.instances.length === 1 ? details.instances[0] : undefined;
  const frame = details.target.kind === "frame"
    ? details.frames.find(candidate => candidate.frameKey === details.target.id)
    : details.summary.frameKey
      ? details.frames.find(candidate => candidate.frameKey === details.summary.frameKey)
      : details.frames.length === 1 ? details.frames[0] : undefined;
  const path = instance?.instancePath ?? frame?.instancePath;
  return {
    ...(attempt === undefined ? {} : { attempt }),
    ...(instance === undefined ? {} : { instance }),
    ...(frame === undefined ? {} : { frame }),
    ...(path === undefined ? {} : { path }),
  };
}

function latestAttempt(attempts: readonly RunDynamicAttempt[]): RunDynamicAttempt | undefined {
  return [...attempts].sort((left, right) => right.attemptNo - left.attemptNo
    || right.startedAt.localeCompare(left.startedAt)
    || right.attemptId.localeCompare(left.attemptId))[0];
}

function targetNode(ir: WorkflowIR, details: ResolvedTargetState): NodeIR | undefined {
  const nodeId = details.staticNode?.nodeId
    ?? details.summary.nodeId
    ?? details.attempts.find(candidate => candidate.attemptId === details.target.id)?.nodeId
    ?? details.instances.find(candidate => candidate.nodeKey === details.target.id)?.nodeId
    ?? details.frames.find(candidate => candidate.frameKey === details.target.id)?.nodeId;
  if (!nodeId) return undefined;
  return Array.from(walkNodes(ir.root), visit => visit.node).find(node => node.id === nodeId);
}

function definition(frozen: FrozenRun, node: NodeIR | undefined): ForensicsDefinition {
  if (!node) {
    const agents = Object.fromEntries(Object.keys(frozen.ir.agents).sort().map(name => [name, frozenAgentProfile(frozen, name)]));
    return {
      kind: "workflow",
      name: frozen.ir.name,
      ...(frozen.ir.description === undefined ? {} : { description: frozen.ir.description }),
      ...(frozen.ir.inputSchema === undefined ? {} : { inputSchema: frozen.ir.inputSchema }),
      agents,
      root: scopeDefinition(frozen.ir.root),
    };
  }
  switch (node.kind) {
    case "agent": {
      const { profile, override } = frozenAgentProfile(frozen, node.run.agent);
      return {
        kind: "agent",
        agent: node.run.agent,
        profile,
        ...(override === undefined ? {} : { override }),
        prompt: formatExpression(node.run.prompt),
        ...(node.run.permissionMode === undefined ? {} : { permissionMode: node.run.permissionMode }),
        ...(node.run.sessionKey === undefined ? {} : { sessionKey: formatExpression(node.run.sessionKey) }),
        ...(node.run.cwd === undefined ? {} : { cwd: formatExpression(node.run.cwd) }),
        ...(node.run.env === undefined ? {} : { env: expressionMap(node.run.env) }),
        ...(node.outputSchema === undefined ? {} : { outputSchema: node.outputSchema }),
        ...(node.timeout === undefined ? {} : { timeout: formatExpression(node.timeout) }),
      };
    }
    case "task":
      return {
        kind: "task",
        input: formatExpression(node.run.input),
        implementation: node.run.target.kind === "inline"
          ? "inline"
          : { kind: "module", specifier: node.run.target.specifier, export: node.run.target.exportName },
        ...(node.run.cwd === undefined ? {} : { cwd: formatExpression(node.run.cwd) }),
        ...(node.run.env === undefined ? {} : { env: expressionMap(node.run.env) }),
        ...(node.run.execution?.defaultCommandTimeout === undefined
          ? {}
          : { defaultCommandTimeout: formatExpression(node.run.execution.defaultCommandTimeout) }),
        ...(node.timeout === undefined ? {} : { timeout: formatExpression(node.timeout) }),
      };
    case "signal":
      return {
        kind: "signal",
        prompt: formatExpression(node.run.prompt),
        ...(node.outputSchema === undefined ? {} : { outputSchema: node.outputSchema }),
        ...(node.timeout === undefined ? {} : { timeout: formatExpression(node.timeout) }),
        ...(node.onTimeout?.message === undefined ? {} : { onTimeoutMessage: formatExpression(node.onTimeout.message) }),
      };
    case "assert":
      return {
        kind: "assert",
        condition: formatExpression(node.condition),
        ...(node.message === undefined ? {} : { message: formatExpression(node.message) }),
      };
    case "if":
      return {
        kind: "if",
        condition: formatExpression(node.condition),
        branches: { then: scopeDefinition(node.then), else: scopeDefinition(node.else) },
      };
    case "switch":
      return {
        kind: "switch",
        cases: node.cases.map((candidate, index) => ({
          id: `case:${index}`,
          when: formatExpression(candidate.when),
          then: scopeDefinition(candidate.then),
        })),
        default: scopeDefinition(node.default),
      };
    case "parallel":
      return {
        kind: "parallel",
        strategy: node.strategy,
        ...(node.maxConcurrency === undefined ? {} : { maxConcurrency: formatExpression(node.maxConcurrency) }),
        branches: Object.fromEntries(Object.entries(node.branches).map(([name, scope]) => [name, scopeDefinition(scope)])),
      };
    case "fanout":
      return {
        kind: "fanout",
        over: formatExpression(node.over),
        strategy: node.strategy,
        ...(node.strategy === "quorum" ? { count: formatExpression(node.count) } : {}),
        ...(node.maxConcurrency === undefined ? {} : { maxConcurrency: formatExpression(node.maxConcurrency) }),
        do: scopeDefinition(node.do),
      };
    case "loop":
      return {
        kind: "loop",
        state: formatExpression(node.state),
        do: {
          nodes: node.do.nodes.map(child => child.id),
          transition: {
            state: formatExpression(node.do.output.fields.state),
            stop: formatExpression(node.do.output.fields.stop),
          },
        },
      };
  }
}

function frozenAgentProfile(frozen: FrozenRun, name: string): {
  profile: FrozenRun["ir"]["agents"][string];
  override?: FrozenRun["agentOverrides"][string];
} {
  const profile = Object.hasOwn(frozen.ir.agents, name) ? frozen.ir.agents[name] : undefined;
  if (!profile) throw new Error(`Agent '${name}' is missing from frozen IR.`);
  const override = Object.hasOwn(frozen.agentOverrides, name) ? frozen.agentOverrides[name] : undefined;
  return { profile, ...(override === undefined ? {} : { override }) };
}

function scopeDefinition(scope: ScopeIR): ForensicsScopeDefinition {
  return { nodes: scope.nodes.map(node => node.id), output: formatExpression(scope.output) };
}

function expressionMap(values: Record<string, ExprIR>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, formatExpression(value)]));
}

function invocation(
  frozen: FrozenRun,
  run: RunDetails,
  details: ResolvedTargetState,
  node: NodeIR | undefined,
  selected: SelectedTarget,
  context: ForensicsExecutionContext[],
  status: RunInspectionStatus,
): ForensicsInvocation {
  if (!node) return { status: "resolved", kind: "workflow", input: frozen.input };
  const unavailable = () => unavailableInvocation(details, selected, context, status);
  if (node.kind === "agent") {
    if (!selected.attempt) return unavailable();
    const metadata = executionMetadata(details, selected.attempt.attemptId, "agent_invocation");
    if (!metadata) return unavailable();
    const prompt = requiredString(metadata, "prompt");
    const promptOrigin = requiredString(metadata, "promptOrigin");
    if (promptOrigin !== "authored" && promptOrigin !== "steering" && promptOrigin !== "continuation") {
      throw new Error("Agent invocation prompt origin is invalid.");
    }
    const permissionMode = requiredString(metadata, "permissionMode");
    if (permissionMode !== "approve-reads" && permissionMode !== "approve-all" && permissionMode !== "deny-all") {
      throw new Error("Agent invocation permission mode is invalid.");
    }
    const sessionKey = optionalString(metadata, "sessionKey");
    const model = optionalString(metadata, "model");
    const deadlineAt = optionalString(metadata, "deadlineAt");
    return withContext({
      status: "resolved",
      kind: "agent",
      attempt: selected.attempt.attemptNo,
      promptOrigin,
      prompt,
      cwd: requiredString(metadata, "cwd"),
      env: stringRecord(metadata.env, "Agent invocation env"),
      ...(model === undefined ? {} : { model }),
      permissionMode,
      ...(sessionKey === undefined ? {} : { sessionKey }),
      ...(metadata.config === undefined ? {} : { config: stringRecord(metadata.config, "Agent invocation config") }),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
    }, context);
  }
  if (node.kind === "task") {
    if (!selected.attempt) return unavailable();
    const metadata = executionMetadata(details, selected.attempt.attemptId, "task_attempt");
    if (!metadata || !isJsonValue(metadata.input)) return unavailable();
    const cwd = optionalString(metadata, "cwd");
    if (cwd === undefined || metadata.env === undefined) return unavailable();
    const timeoutMs = optionalNumber(metadata, "timeoutMs");
    const defaultCommandTimeout = optionalString(metadata, "defaultCommandTimeout");
    return withContext({
      status: "resolved",
      kind: "task",
      attempt: selected.attempt.attemptNo,
      input: metadata.input,
      cwd,
      env: stringRecord(metadata.env, "Task invocation env"),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(defaultCommandTimeout === undefined ? {} : { defaultCommandTimeout }),
    }, context);
  }
  if (node.kind === "signal") {
    const nodeKey = selected.instance?.nodeKey ?? selected.frame?.nodeKey;
    const wait = nodeKey === undefined ? undefined : run.dynamic?.signalWaits.find(candidate => candidate.nodeKey === nodeKey);
    if (!wait || wait.renderedPrompt === undefined) return unavailable();
    return withContext({
      status: "resolved",
      kind: "signal",
      prompt: wait.renderedPrompt,
      ...(wait.deadlineAt === undefined ? {} : { deadlineAt: wait.deadlineAt }),
    }, context);
  }
  if (node.kind === "assert") {
    const reason = selected.frame?.terminalReason;
    if (reason !== "assert_passed" && reason !== "assert_failed") return unavailable();
    return withContext({ status: "resolved", kind: "assert", condition: reason === "assert_passed" }, context);
  }
  if (node.kind === "if" || node.kind === "switch") {
    const branchId = selectedBranch(run, selected);
    if (!branchId) return unavailable();
    return withContext({ status: "resolved", kind: node.kind, selectedBranch: branchId }, context);
  }
  if (node.kind === "parallel") {
    const group = run.dynamic?.groups.find(candidate => candidate.groupKey === selected.frame?.frameKey);
    if (!group || group.kind !== "parallel") return unavailable();
    return withContext({
      status: "resolved",
      kind: "parallel",
      ...(group.maxConcurrency === undefined ? {} : { maxConcurrency: group.maxConcurrency }),
    }, context);
  }
  if (node.kind === "fanout") {
    const group = run.dynamic?.groups.find(candidate => candidate.groupKey === selected.frame?.frameKey);
    if (!group || group.kind !== "fanout") return unavailable();
    const items = (run.dynamic?.groupMembers ?? [])
      .flatMap(member => member.groupKey === group.groupKey && member.memberKind === "fanout_item"
        ? [{ itemIndex: member.itemIndex, item: member.item }]
        : [])
      .sort((left, right) => left.itemIndex - right.itemIndex)
      .map(member => member.item);
    return withContext({
      status: "resolved",
      kind: "fanout",
      items,
      ...(group.quorumCount === undefined ? {} : { quorumCount: group.quorumCount }),
      ...(group.maxConcurrency === undefined ? {} : { maxConcurrency: group.maxConcurrency }),
    }, context);
  }
  const frame = selected.frame;
  if (!frame?.loop) return unavailable();
  return withContext({
    status: "resolved",
    kind: "loop",
    index: frame.loop.index,
    round: frame.loop.round,
    ...(frame.loop.state === undefined ? {} : { state: frame.loop.state }),
    ...(frame.loop.transition === undefined ? {} : { transition: frame.loop.transition }),
  }, context);
}

function withContext(
  value: Exclude<ForensicsInvocation, { status: "unavailable" }>,
  context: ForensicsExecutionContext[],
): ForensicsInvocation {
  return context.length === 0 ? value : { ...value, context };
}

function unavailableInvocation(
  details: ResolvedTargetState,
  selected: SelectedTarget,
  context: ForensicsExecutionContext[],
  status: RunInspectionStatus,
): ForensicsInvocation {
  const reason = status === "not_started"
    ? "not_started"
    : status === "not_selected"
      ? "not_selected"
      : resolutionFailed(details, selected)
        ? "resolution_failed"
        : status === "starting" || status === "ready" || status === "running" || status === "pending" || status === "awaiting"
          ? "not_yet_resolved"
          : "not_recorded";
  return { status: "unavailable", reason, ...(context.length === 0 ? {} : { context }) };
}

function resolutionFailed(details: ResolvedTargetState, selected: SelectedTarget): boolean {
  const reasons = [
    selected.attempt?.terminalReason,
    selected.instance?.statusReason,
    selected.frame?.terminalReason,
    record(selected.attempt?.error)?.reason,
    record(selected.instance?.error)?.reason,
    record(selected.frame?.error)?.reason,
    details.summary.failure?.code,
  ];
  return reasons.some(value => typeof value === "string" && (value === "expression_failed" || value === "expression_resolution_failed"));
}

function executionMetadata(details: ResolvedTargetState, attemptId: string, kind: string): Record<string, unknown> | undefined {
  const metadata = [...details.executionMetadata]
    .filter(candidate => candidate.attemptId === attemptId && candidate.kind === kind)
    .sort((left, right) => right.id - left.id)[0];
  return record(metadata?.metadata);
}

function selectedBranch(run: RunDetails, selected: SelectedTarget): string | undefined {
  const direct = lastSegment(selected.path);
  if (direct?.kind === "branch") return direct.branchId;
  if (!selected.frame) return undefined;
  const branch = run.dynamic?.frames.find(candidate =>
    candidate.parentFrameKey === selected.frame?.frameKey
    && candidate.frameKind === "branch");
  const segment = lastSegment(branch?.instancePath);
  return segment?.kind === "branch" ? segment.branchId : undefined;
}

function result(
  run: RunDetails,
  details: ResolvedTargetState,
  selected: SelectedTarget,
  status: RunInspectionStatus,
  node: NodeIR | undefined,
): ForensicsResult {
  if (details.target.id === "root") {
    if (run.status === "completed") return acceptedOutput(run.output);
    if (run.status === "failed") return { status: "failed", ...failure(details, selected) };
    if (run.status === "canceled") return { status: "cancelled" };
    return { status: run.status === "pending" ? "not_started" : "pending" };
  }
  if (details.target.kind === "attempt" && selected.attempt) {
    if (selected.attempt.status === "superseded") return { status: "not_accepted" };
    if (selected.attempt.status === "failed") return { status: "failed", ...failure(details, selected) };
    if (selected.attempt.status === "timed_out") return { status: "timed_out", ...failure(details, selected) };
    if (selected.attempt.status === "cancelled") return { status: "cancelled" };
    if (selected.attempt.status !== "completed") return { status: "pending" };
    if (selected.instance?.acceptedAttemptId !== selected.attempt.attemptId) return { status: "not_accepted" };
    return acceptedOutput(selected.instance.output);
  }
  if (status === "not_started") return { status: "not_started" };
  if (status === "not_selected") return { status: "not_selected" };
  if (status === "failed") return { status: "failed", ...failure(details, selected) };
  if (status === "timed_out") return { status: "timed_out", ...failure(details, selected) };
  if (status === "cancelled") return { status: "cancelled" };
  if (status !== "completed") return { status: "pending" };
  if (node?.kind === "assert") return { status: "completed_without_output" };
  if (selected.instance) return acceptedOutput(selected.instance.output);
  if (selected.frame) return acceptedOutput(selected.frame.result);
  return { status: "completed_without_output" };
}

function acceptedOutput(value: unknown): ForensicsResult {
  if (value === undefined) return { status: "completed_without_output" };
  if (!isJsonValue(value)) throw new Error("Accepted inspection output is not JSON-compatible.");
  return { status: "accepted", value };
}

function failure(details: ResolvedTargetState, selected: SelectedTarget): { code?: string; message: string } {
  if (details.summary.failure) {
    return {
      ...(details.summary.failure.code === undefined ? {} : { code: details.summary.failure.code }),
      message: details.summary.failure.message,
    };
  }
  const error = record(selected.attempt?.error) ?? record(selected.instance?.error) ?? record(selected.frame?.error);
  const code = string(error?.code) ?? string(error?.reason);
  const message = string(error?.message) ?? code ?? "Target failed.";
  return { ...(code === undefined ? {} : { code }), message };
}

function targetStatus(
  ir: WorkflowIR,
  run: RunDetails,
  details: ResolvedTargetState,
  selected: SelectedTarget,
  node: NodeIR | undefined,
): RunInspectionStatus {
  if (details.target.id === "root") {
    if (run.status === "completed" || run.status === "failed") return run.status;
    if (run.status === "canceled") return "cancelled";
    if (run.status === "pending") return "not_started";
    return selected.frame ? normalizeStatus(selected.frame.status) : "running";
  }
  if (selected.attempt) {
    if (details.target.kind === "attempt") {
      if (selected.attempt.status === "timed_out") return "timed_out";
      if (selected.attempt.status === "superseded") return "cancelled";
      return normalizeStatus(selected.attempt.status);
    }
  }
  const instance = selected.instance;
  const wait = instance
    ? run.dynamic?.signalWaits.find(candidate => candidate.nodeKey === instance.nodeKey)
    : undefined;
  if (wait?.status === "timed_out") return "timed_out";
  if (wait?.status === "awaiting") return "awaiting";
  if (instance) {
    if (selected.attempt?.status === "timed_out") return "timed_out";
    return normalizeStatus(instance.status);
  }
  if (selected.frame) return normalizeStatus(selected.frame.status);
  if (node && staticallyNotSelected(ir, run, node.id)) return "not_selected";
  const staticStatus = details.items.find(item => item.nodeId === details.staticNode?.nodeId && item.status === "not_selected")?.status;
  return staticStatus ?? normalizeStatus(details.summary.nodeStatus ?? "not_started");
}

function staticallyNotSelected(ir: WorkflowIR, run: RunDetails, nodeId: string): boolean {
  const visit = Array.from(walkNodes(ir.root)).find(candidate => candidate.node.id === nodeId);
  if (!visit) return false;
  return visit.ancestry.some(ancestor => {
    if (ancestor.kind !== "if" && ancestor.kind !== "switch") return false;
    const ownerFrames = (run.dynamic?.frames ?? []).filter(frame =>
      frame.nodeId === ancestor.owner.id
      && (frame.frameKind === "node" || frame.frameKind === "loop"));
    if (ownerFrames.length === 0) return false;
    const decisions = ownerFrames.flatMap(owner => (run.dynamic?.frames ?? []).flatMap(frame => {
      if (frame.parentFrameKey !== owner.frameKey || frame.frameKind !== "branch") return [];
      const segment = lastSegment(frame.instancePath);
      return segment?.kind === "branch" ? [segment.branchId] : [];
    }));
    return decisions.length > 0 && decisions.every(branchId => branchId !== ancestor.branchId);
  });
}

function normalizeStatus(status: string): RunInspectionStatus {
  if (status === "started") return "running";
  if (status === "canceled" || status === "superseded") return "cancelled";
  if (status === "consumed") return "completed";
  const known: RunInspectionStatus[] = ["not_started", "not_selected", "pending", "starting", "ready", "running", "awaiting", "completed", "failed", "timed_out", "cancelled", "mixed"];
  return known.includes(status as RunInspectionStatus) ? status as RunInspectionStatus : "mixed";
}

function targetDurationMs(run: RunDetails, selected: SelectedTarget, root: boolean): number | undefined {
  if (selected.attempt?.finishedAt) return elapsed(selected.attempt.startedAt, selected.attempt.finishedAt);
  if (selected.frame && terminalStatus(selected.frame.status)) return elapsed(selected.frame.createdAt, selected.frame.updatedAt);
  if (selected.instance && terminalStatus(selected.instance.status)) return elapsed(selected.instance.createdAt, selected.instance.updatedAt);
  if (root && (run.status === "completed" || run.status === "failed" || run.status === "canceled")) {
    return elapsed(run.createdAt, run.updatedAt);
  }
  return undefined;
}

function terminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "canceled" || status === "superseded";
}

function elapsed(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function executionContext(ir: WorkflowIR, run: RunDetails, path: InstancePath | undefined): ForensicsExecutionContext[] {
  if (!path) return [];
  const nodes = new Map(Array.from(walkNodes(ir.root), visit => [visit.node.id, visit.node]));
  const context: ForensicsExecutionContext[] = [];
  const prefix: InstancePathSegment[] = [];
  for (const segment of path) {
    if (segment.kind === "branch") {
      const owner = nodes.get(segment.nodeId);
      if (owner?.kind === "if" || owner?.kind === "switch" || owner?.kind === "parallel") {
        context.push({ kind: "branch", nodeId: segment.nodeId, ownerKind: owner.kind, branchId: segment.branchId });
      }
    } else if (segment.kind === "fanout") {
      const groupKey = deriveInstanceKey(appendNode(prefix, segment.nodeId));
      const member = run.dynamic?.groupMembers.find(candidate =>
        candidate.groupKey === groupKey
        && candidate.memberKind === "fanout_item"
        && candidate.itemIndex === segment.itemIndex);
      if (member?.memberKind === "fanout_item") {
        context.push({ kind: "fanout", nodeId: segment.nodeId, itemIndex: segment.itemIndex, item: member.item });
      }
    } else if (segment.kind === "loop") {
      const frameKey = deriveInstanceKey(appendNode(prefix, segment.nodeId));
      const loop = run.dynamic?.frames.find(candidate => candidate.frameKey === frameKey)?.loop;
      context.push({
        kind: "loop",
        nodeId: segment.nodeId,
        index: segment.iter,
        round: segment.iter + 1,
        ...(loop?.iter === segment.iter && loop.state !== undefined ? { state: loop.state } : {}),
      });
    }
    prefix.push(segment);
  }
  return context;
}

function lastSegment(path: InstancePath | undefined): InstancePathSegment | undefined {
  return path?.at(-1);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = optionalString(value, field);
  if (result === undefined) throw new Error(`Invocation metadata field '${field}' is missing.`);
  return result;
}

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
  const result = value[field];
  if (result === undefined) return undefined;
  if (typeof result !== "string") throw new Error(`Invocation metadata field '${field}' is not a string.`);
  return result;
}

function optionalNumber(value: Record<string, unknown>, field: string): number | undefined {
  const result = value[field];
  if (result === undefined) return undefined;
  if (typeof result !== "number" || !Number.isFinite(result)) throw new Error(`Invocation metadata field '${field}' is not a finite number.`);
  return result;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const result = record(value);
  if (!result || Object.values(result).some(item => typeof item !== "string")) throw new Error(`${label} is invalid.`);
  return result as Record<string, string>;
}

function formatExpression(expr: ExprIR): string {
  if (expr.kind === "literal") return formatLiteral(expr.value);
  if (expr.kind === "ref") return expr.path.map((segment, index) => {
    if (/^[A-Za-z_$][\w$]*$/.test(segment)) return index === 0 ? segment : `.${segment}`;
    if (/^(0|[1-9]\d*)$/.test(segment)) return `[${segment}]`;
    return `[${JSON.stringify(segment)}]`;
  }).join("");
  if (expr.kind === "array") return `[${expr.items.map(formatExpression).join(", ")}]`;
  if (expr.kind === "object") {
    return `{ ${Object.entries(expr.fields).map(([key, value]) => `${formatObjectKey(key)}: ${formatExpression(value)}`).join(", ")} }`;
  }
  if (expr.kind === "template") return `\`${formatTemplate(expr)}\``;
  return `${expr.fn}(${expr.args.map(formatExpression).join(", ")})`;
}

function formatTemplate(template: TemplateIR): string {
  return template.parts.map(part => part.kind === "text"
    ? part.value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
    : `\${${formatExpression(part.expr)}}`).join("");
}

function formatObjectKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function formatLiteral(value: JsonPrimitive): string {
  return typeof value === "string" ? JSON.stringify(value) : value === null ? "null" : String(value);
}
