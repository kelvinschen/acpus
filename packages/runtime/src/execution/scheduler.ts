import type { AgentNodeIR, NodeIR, ScopeIR, SignalNodeIR, TaskNodeIR, WorkflowIR } from "@acpus/core/ir";
import type { ExprIR, JsonValue } from "@acpus/expression/ir";
import { assertWorkflowData } from "../evaluation/admissible.js";
import { evaluateExpr, renderTemplate, type EvaluationScope } from "../evaluation/evaluator.js";
import { evaluateLoopMaxIterations } from "../evaluation/loop-limit.js";
import { normalizeValue } from "../evaluation/schema.js";

export type NonAgentExecutionResult = {
  status: "completed";
  output: Record<string, unknown>;
  nodes: Record<string, { status: "completed"; output: unknown }>;
  executedNodes: Record<string, { status: "completed"; output: unknown }>;
};

export type RuntimeExecutionOptions = {
  taskExecutor?: (node: TaskNodeIR, scope: EvaluationScope) => Promise<unknown>;
  agentExecutor?: (node: AgentNodeIR, scope: EvaluationScope) => Promise<unknown>;
  signalPayloads?: Record<string, unknown>;
  completedNodes?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export class ExecutorRequiredError extends Error {
  constructor(
    readonly nodeId: string,
    readonly nodeKind: "task" | "agent" | "signal",
    readonly executedNodes: Record<string, { status: "completed"; output: unknown }> = {},
    message?: string,
  ) {
    super(message ?? `Executable node '${nodeId}' (${nodeKind}) requires a node executor.`);
  }
}

export class RuntimeNodeError extends Error {
  constructor(
    readonly nodeId: string,
    message: string,
    readonly executedNodes: Record<string, { status: "completed"; output: unknown }> = {},
  ) {
    super(message);
  }
}

export class SignalAwaitingError extends Error {
  constructor(
    readonly nodeId: string,
    readonly node: SignalNodeIR,
    readonly executedNodes: Record<string, { status: "completed"; output: unknown }>,
  ) {
    super(`Signal node '${nodeId}' is awaiting payload.`);
  }
}

type ScopeExecutionResult = {
  output: Record<string, unknown>;
  scope: SchedulerScope;
};

type CompletedNodeState = { status: "completed"; output: unknown };
type SchedulerScope = EvaluationScope & {
  nodes: Record<string, CompletedNodeState>;
  executedNodes: Record<string, CompletedNodeState>;
};

export async function executeWorkflow(ir: WorkflowIR, input: JsonValue, options: RuntimeExecutionOptions = {}): Promise<NonAgentExecutionResult> {
  const scope = createRootScope(input, options.meta ?? {});
  for (const [nodeId, output] of Object.entries(options.completedNodes ?? {})) {
    assertWorkflowData(output, `Completed node '${nodeId}' output`);
    const state = { status: "completed" as const, output };
    scope.nodes[nodeId] = state;
    scope.executedNodes[nodeId] = state;
  }
  const scopeResult = await executeScopeAsync(ir.root, scope, options);
  const rootOutput = evaluateOutputs(ir.outputs, scope);
  return {
    status: "completed",
    output: Object.keys(ir.outputs).length === 0 ? scopeResult.output : rootOutput,
    nodes: scope.nodes,
    executedNodes: scope.executedNodes,
  };
}

async function executeScopeAsync(scopeIr: ScopeIR, scope: SchedulerScope, options: RuntimeExecutionOptions): Promise<ScopeExecutionResult> {
  for (const node of scopeIr.nodes) await executeNodeAsync(node, scope, options);
  return {
    output: evaluateOutputs(scopeIr.outputs ?? {}, scope),
    scope,
  };
}

async function executeNodeAsync(node: NodeIR, scope: SchedulerScope, options: RuntimeExecutionOptions): Promise<void> {
  if (scope.nodes[node.id]) return;
  if (node.kind === "task") {
    if (!options.taskExecutor) throw new ExecutorRequiredError(node.id, node.kind, scope.executedNodes);
    try {
      completeNode(scope, node.id, validateNodeOutput(node, await options.taskExecutor(node, scope)));
    } catch (error) {
      throw new RuntimeNodeError(node.id, error instanceof Error ? error.message : String(error), scope.executedNodes);
    }
    return;
  }
  if (node.kind === "signal") {
    if (!options.signalPayloads || !(node.id in options.signalPayloads)) throw new SignalAwaitingError(node.id, node, scope.executedNodes);
    completeNode(scope, node.id, validateSignalOutput(node, options.signalPayloads[node.id]));
    return;
  }
  if (node.kind === "agent") {
    if (!options.agentExecutor) throw new ExecutorRequiredError(node.id, node.kind, scope.executedNodes);
    try {
      completeNode(scope, node.id, validateNodeOutput(node, await options.agentExecutor(node, scope)));
    } catch (error) {
      if (error instanceof ExecutorRequiredError) throw error;
      throw new RuntimeNodeError(node.id, error instanceof Error ? error.message : String(error), scope.executedNodes);
    }
    return;
  }
  if (node.kind === "assert") {
    if (evaluateBoolean(node.condition, scope, node.id)) {
      completeNode(scope, node.id, {});
      return;
    }
    throw new RuntimeNodeError(node.id, renderAssertFailure(node, scope), scope.executedNodes);
  }
  if (node.kind === "if") {
    try {
      const output = (await executeScopeAsync(evaluateBoolean(node.condition, scope, node.id) ? node.then : node.else, createChildScope(scope), options)).output;
      completeNode(scope, node.id, validateNodeOutput(node, output));
    } catch (error) {
      if (error instanceof ExecutorRequiredError || error instanceof SignalAwaitingError || error instanceof RuntimeNodeError) throw error;
      throw new RuntimeNodeError(node.id, error instanceof Error ? error.message : String(error), scope.executedNodes);
    }
    return;
  }
  if (node.kind === "switch") {
    try {
      const selected = node.cases.find(c => evaluateBoolean(c.when, scope, node.id))?.then ?? node.default;
      completeNode(scope, node.id, validateNodeOutput(node, (await executeScopeAsync(selected, createChildScope(scope), options)).output));
    } catch (error) {
      if (error instanceof ExecutorRequiredError || error instanceof SignalAwaitingError || error instanceof RuntimeNodeError) throw error;
      throw new RuntimeNodeError(node.id, error instanceof Error ? error.message : String(error), scope.executedNodes);
    }
    return;
  }
  if (node.kind === "parallel") {
    try {
      if (node.strategy === "race") {
        const entries = Object.entries(node.branches);
        if (entries.length === 0) throw new Error(`Parallel race node '${node.id}' had no successful branches.`);
        const winner = await new Promise<{ key: string; result: Record<string, unknown>; executedNodes: Record<string, CompletedNodeState> }>((resolve, reject) => {
          const failures: string[] = [];
          let pending = entries.length;
          let settled = false;
          for (const [key, branch] of entries) {
            const branchExecuted: Record<string, CompletedNodeState> = {};
            executeScopeAsync(branch.scope, createChildScope(scope, {}, branchExecuted), options)
              .then(result => {
                if (settled) return;
                settled = true;
                resolve({ key, result: result.output, executedNodes: branchExecuted });
              })
              .catch(error => {
                failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
                pending -= 1;
                if (!settled && pending === 0) {
                  reject(new Error(`Parallel race node '${node.id}' had no successful branches.${failures.length ? ` ${failures.join("; ")}` : ""}`));
                }
              });
          }
        });
        Object.assign(scope.executedNodes, winner.executedNodes);
        completeNode(scope, node.id, { winner: winner.key, result: winner.result });
        return;
      }
      const entries = await Promise.all(Object.entries(node.branches).map(async ([key, branch]) => [
        key,
        (await executeScopeAsync(branch.scope, createChildScope(scope), options)).output,
      ] as const));
      completeNode(scope, node.id, Object.fromEntries(entries));
    } catch (error) {
      if (error instanceof ExecutorRequiredError || error instanceof SignalAwaitingError || error instanceof RuntimeNodeError) throw error;
      throw new RuntimeNodeError(node.id, error instanceof Error ? error.message : String(error), scope.executedNodes);
    }
    return;
  }
  if (node.kind === "fanout") {
    try {
      const items = evaluateExpr(node.over, scope);
      if (!Array.isArray(items)) throw new Error(`Fanout node '${node.id}' expected array input.`);
      if (node.strategy === "quorum") {
        const completed: unknown[] = [];
        await Promise.all(items.map((item, itemIndex) => executeScopeAsync(node.do, createFanoutItemScope(scope, node.id, item, itemIndex), options).then(result => {
          completed.push(result.output);
        })));
        if (completed.length < node.count) throw new Error(`Fanout quorum node '${node.id}' accepted ${completed.length} items, below required count ${node.count}.`);
        completeNode(scope, node.id, completed.slice(0, node.count));
        return;
      }
      const completed = await Promise.all(items.map(async (item, itemIndex) => (await executeScopeAsync(node.do, createFanoutItemScope(scope, node.id, item, itemIndex), options)).output));
      completeNode(scope, node.id, completed);
    } catch (error) {
      if (error instanceof ExecutorRequiredError || error instanceof SignalAwaitingError || error instanceof RuntimeNodeError) throw error;
      throw new RuntimeNodeError(node.id, error instanceof Error ? error.message : String(error), scope.executedNodes);
    }
    return;
  }
  if (node.kind === "loop") {
    try {
      let result = evaluateExpr(node.initial, scope) as Record<string, unknown>;
      const maxIterations = evaluateLoopMaxIterations(node.maxIterations, scope, node.id);
      for (let iter = 0; iter < maxIterations; iter += 1) {
        scope.loop = {
          ...scope.loop,
          [node.id]: { iter, previous: result, result },
        };
        if (evaluateBoolean(node.stopWhen, scope, node.id)) {
          completeNode(scope, node.id, validateNodeOutput(node, result));
          return;
        }
        const loopScope = createChildScope(scope, {
          loop: {
            ...scope.loop,
            [node.id]: { iter, previous: result },
          },
        });
        result = (await executeScopeAsync(node.do, loopScope, options)).output as Record<string, unknown>;
        scope.loop = {
          ...scope.loop,
          [node.id]: { iter, previous: result, result },
        };
      }
      const iter = maxIterations;
      scope.loop = {
        ...scope.loop,
        [node.id]: { iter, previous: result, result },
      };
      if (evaluateBoolean(node.stopWhen, scope, node.id) || node.onExhausted === "returnLast") {
        completeNode(scope, node.id, validateNodeOutput(node, result));
        return;
      }
      throw new Error(`Loop node '${node.id}' exhausted after ${maxIterations} iterations.`);
    } catch (error) {
      if (error instanceof ExecutorRequiredError || error instanceof SignalAwaitingError || error instanceof RuntimeNodeError) throw error;
      throw new RuntimeNodeError(node.id, error instanceof Error ? error.message : String(error), scope.executedNodes);
    }
  }
}

function evaluateOutputs(outputs: Record<string, ExprIR>, scope: SchedulerScope): Record<string, unknown> {
  return Object.fromEntries(Object.entries(outputs).map(([key, expr]) => [key, evaluateExpr(expr, scope)]));
}

function evaluateBoolean(expr: ExprIR, scope: SchedulerScope, nodeId: string): boolean {
  const value = evaluateExpr(expr, scope);
  if (typeof value !== "boolean") throw new Error(`Node '${nodeId}' condition must evaluate to boolean.`);
  return value;
}

function completeNode(scope: SchedulerScope, id: string, output: unknown): void {
  const state = { status: "completed" as const, output };
  scope.nodes = {
    ...scope.nodes,
    [id]: state,
  };
  scope.executedNodes[id] = state;
}

function validateNodeOutput(node: NodeIR, output: unknown): unknown {
  const normalized = (node.kind === "agent" || node.kind === "signal") && node.outputSchema
    ? normalizeValue(node.outputSchema, output as JsonValue, `Node '${node.id}' output`)
    : output;
  assertWorkflowData(normalized, `Node '${node.id}' output`);
  return normalized;
}

function validateSignalOutput(node: SignalNodeIR, output: unknown): unknown {
  if (!node.outputSchema && typeof output !== "string") throw new Error(`Signal node '${node.id}' payload must be a string.`);
  return validateNodeOutput(node, output);
}

function createRootScope(input: JsonValue, meta: Record<string, unknown>): SchedulerScope {
  return {
    input,
    nodes: {},
    executedNodes: {},
    meta,
    fanout: {},
    loop: {},
  };
}

function createChildScope(parent: SchedulerScope, overrides: Partial<EvaluationScope> = {}, executedNodes = parent.executedNodes): SchedulerScope {
  return {
    input: parent.input,
    nodes: { ...parent.nodes },
    executedNodes,
    meta: overrides.meta ?? { ...parent.meta },
    fanout: overrides.fanout ?? { ...parent.fanout },
    loop: overrides.loop ?? { ...parent.loop },
  };
}

function createFanoutItemScope(parent: SchedulerScope, nodeId: string, item: unknown, itemIndex: number): SchedulerScope {
  return createChildScope(parent, {
    fanout: {
      ...parent.fanout,
      [nodeId]: { item, itemIndex },
    },
  });
}

function renderAssertFailure(node: Extract<NodeIR, { kind: "assert" }>, scope: SchedulerScope): string {
  if (!node.message) return `Assert node '${node.id}' failed.`;
  return `Assert node '${node.id}' failed: ${renderTemplate(node.message, scope)}`;
}
