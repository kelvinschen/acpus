import { WORKFLOW } from "../internal/symbols.js";
import { makeNodeRef, refExpr, type ExprValue, type NodeRef } from "./refs.js";
import type { Resolvable } from "@acpus/expression";
import type { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { toSchemaIR, type Schema } from "../schema/index.js";
import { agentToken, buildAgentNode, lowerAgentDefinitions, type AgentDefinitionSpec, type AgentStepSpec, type AgentToken } from "../nodes/leaf/agent.js";
import {
  buildTaskNode,
  TaskCompilationAbort,
  type InlineTaskStepSpec,
  type ReusableTaskLinkPlan,
  type ReusableTaskStepSpec,
  type TaskCompilationFailure,
  type TaskResult,
  type TaskStepSpec,
} from "../nodes/leaf/task.js";
import { buildSignalNode, type SignalStepSpec } from "../nodes/leaf/signal.js";
import type { RuntimeInput, StepInput } from "../nodes/leaf/shared.js";
import { buildAssertNode, type AssertSpec } from "../nodes/control/assert.js";
import { buildIfNode, type IfNodeRefOutput, type IfStepSpec } from "../nodes/composite/if.js";
import { buildSwitchNode, type SwitchNodeRefOutput, type SwitchStepSpec } from "../nodes/composite/switch.js";
import { buildParallelNode, type ParallelNodeRefOutput, type ParallelStepSpec } from "../nodes/composite/parallel.js";
import { buildFanoutNode, type FanoutNodeRefOutput, type FanoutStepSpec } from "../nodes/composite/fanout.js";
import { buildLoopNode, type LoopStepSpec, type LoopTransitionOutput } from "../nodes/composite/loop.js";
import { buildImplicitScope as buildScopeIR, type GraphOutputCheck, type TaskOutputCheck } from "./scope.js";
import { outputToIR, stripUndefined } from "./lowering.js";
import type { FanoutStrategy, ParallelStrategy, ResolvableArray, RuntimeValueOf, ScopeCallback } from "../nodes/composite/shared.js";
import type { TaskFunction } from "../runtime/task-context.js";
import type {
  DiagnosticIR,
  ExprIR,
  NodeIR,
  ScopeIR,
  WorkflowIR,
} from "../ir/types.js";
import { validateWorkflowIR } from "../ir/validator.js";

export type { AgentStepSpec } from "../nodes/leaf/agent.js";
export type { TaskStepSpec } from "../nodes/leaf/task.js";
export type { SignalStepSpec } from "../nodes/leaf/signal.js";
export type { StepInput, GraphInput, RuntimeInput } from "../nodes/leaf/shared.js";
export type AgentMap = Record<string, AgentDefinitionSpec>;
type AgentRegistry<Agents extends AgentMap | undefined = AgentMap | undefined> = Agents extends AgentMap
  ? { readonly [K in Extract<keyof Agents, string>]: AgentToken<K> }
  : {};

type WorkflowMeta = {
  runId: string;
  workflowPath: string;
  workflowName: string;
  workspaceDir: string;
};

export type WorkflowConfig<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined> = {
  name: string;
  description?: string;
  inputSchema?: InputSchema;
  agents?: Agents;
};

export type WorkflowDefinition<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined> = {
  readonly [WORKFLOW]: true;
  readonly config: WorkflowConfig<InputSchema, Agents>;
  readonly buildFn: BuildFn<InputSchema, Agents>;
};

/**
 * Context passed to a workflow `.build(...)` callback.
 *
 * The `input`, `meta`, and node output values available through this context
 * are expression tokens during graph construction, not runtime JavaScript
 * values.
 */
export type BuildContext<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined = undefined> = {
  input: InputSchema extends Schema<infer Input> ? ExprValue<Input> : {};
  agents: AgentRegistry<Agents>;
  meta: ExprValue<WorkflowMeta>;
  step: StepFactory;
};

type BuildFn<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined = undefined> = (ctx: BuildContext<InputSchema, Agents>) => unknown;

type CheckedBuildFn<
  InputSchema extends Schema<any> | undefined,
  Agents extends AgentMap | undefined,
  Output,
> = ((ctx: BuildContext<InputSchema, Agents>) => Output)
  & ((ctx: BuildContext<InputSchema, Agents>) => Output & GraphOutputCheck<NoInfer<Output>>);

/**
 * Creates a typed Acpus workflow definition.
 *
 * Call `.build(({ input, agents, meta, step }) => ...)` on the returned builder
 * to declare the workflow graph. Values from `input`, `agents`, and prior node
 * outputs are expression tokens during graph construction, not runtime
 * JavaScript values.
 */
export function defineWorkflow<InputSchema extends Schema<any> | undefined = undefined, Agents extends AgentMap | undefined = undefined>(config: WorkflowConfig<InputSchema, Agents>) {
  return {
    build<Output>(buildFn: CheckedBuildFn<InputSchema, Agents, Output>): WorkflowDefinition<InputSchema, Agents> {
      return { [WORKFLOW]: true as const, config, buildFn };
    },
  };
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition<any, any> {
  return Boolean(value && typeof value === "object" && (value as any)[WORKFLOW]);
}

export type StepDeclaration = {
  /** Declares an Agent node for model-backed judgment, synthesis, planning, or review. */
  agent<OutSchema extends Schema<any>>(
    spec: AgentStepSpec<OutSchema>,
  ): NodeRef<z.output<OutSchema>>;

  agent(
    spec: AgentStepSpec<undefined>,
  ): NodeRef<string>;

  /** Declares a Task node for deterministic local automation and artifact writing. */
  task<const Input extends StepInput, Exec extends TaskFunction<RuntimeInput<Input>, any>>(
    spec: InlineTaskStepSpec<Input, Exec>,
  ): NodeRef<TaskResult<Exec>>;

  task<const Input extends StepInput, TaskInput, Output>(
    spec: ReusableTaskStepSpec<Input, TaskInput, Output>
      & (RuntimeInput<Input> extends TaskInput ? unknown : never)
      & TaskOutputCheck<Output>,
  ): NodeRef<Output>;

  /** Declares a Signal node that waits for operator input. */
  signal<OutSchema extends Schema<any>>(
    spec: SignalStepSpec<OutSchema>,
  ): NodeRef<z.output<OutSchema>>;

  signal(
    spec: SignalStepSpec<undefined>,
  ): NodeRef<string>;

  /** Declares an Assert node that fails the run when its condition is false. */
  assert(spec: AssertSpec): void;

  /** Declares a graph-level conditional branch. */
  if<const Then extends ScopeCallback, const Else extends ScopeCallback>(
    spec: IfStepSpec<Then, Else>,
  ): NodeRef<IfNodeRefOutput<Then, Else>>;

  /** Declares a graph-level switch with explicit cases and a required default branch. */
  switch<const Cases extends ReadonlyArray<{ when: Resolvable<boolean>; then: ScopeCallback }>, const Default extends ScopeCallback>(
    spec: SwitchStepSpec<Cases, Default>,
  ): NodeRef<SwitchNodeRefOutput<Cases, Default>>;

  /** Declares static parallel branches. Race strategy returns a winner/result envelope. */
  parallel<const Branches extends Record<string, ScopeCallback>>(
    spec: ParallelStepSpec<Branches, "race">,
  ): NodeRef<ParallelNodeRefOutput<Branches, "race">>;

  parallel<const Branches extends Record<string, ScopeCallback>>(
    spec: ParallelStepSpec<Branches, "all">,
  ): NodeRef<ParallelNodeRefOutput<Branches, "all">>;

  /** Declares runtime fanout over a workflow array value. */
  fanout<const Over extends ResolvableArray<any>, Output>(
    spec: FanoutStepSpec<Over, Output, "quorum">,
  ): NodeRef<FanoutNodeRefOutput<Output>>;

  fanout<const Over extends ResolvableArray<any>, Output>(
    spec: FanoutStepSpec<Over, Output, "all">,
  ): NodeRef<FanoutNodeRefOutput<Output>>;

  /** Declares a transition-style loop that always executes at least one iteration. */
  loop<Initial, Transition extends LoopTransitionOutput<Initial>>(
    spec: LoopStepSpec<Initial, Transition>,
  ): NodeRef<RuntimeValueOf<Initial>>;
};

export type StepFactory = (id: string) => StepDeclaration;

type GraphBuildState = {
  readonly nodes: NodeIR[];
};

class GraphBuildContext {
  private readonly scopes: GraphBuildState[] = [];
  private closed = false;

  readonly step: StepFactory = (id: string) => this.declare(id);

  constructor(readonly reusableTasks: ReusableTaskLinkPlan | undefined) {}

  withScope<T>(scope: GraphBuildState, fn: () => T): T {
    if (this.closed) {
      throw new Error("step() can only be called during workflow graph declaration.");
    }
    this.scopes.push(scope);
    try {
      return fn();
    } finally {
      this.scopes.pop();
    }
  }

  private activeScope(): GraphBuildState {
    const active = this.scopes.at(-1);
    if (!active || this.closed) {
      throw new Error("step() can only be called during workflow graph declaration.");
    }
    return active;
  }

  private appendNode<Output>(id: string, build: () => NodeIR): NodeRef<Output> {
    const scope = this.activeScope();
    scope.nodes.push(build());
    return makeNodeRef(id);
  }

  private declare(id: string): StepDeclaration {
    this.activeScope();
    const agent = ((spec: AgentStepSpec<Schema<any> | undefined>) =>
      this.appendNode(id, () => buildAgentNode(id, spec))) as StepDeclaration["agent"];
    const task = ((spec: TaskStepSpec<StepInput>) =>
      this.appendNode(id, () => buildTaskNode(id, spec, this.reusableTasks))) as StepDeclaration["task"];
    const signal = ((spec: SignalStepSpec<Schema<any> | undefined>) =>
      this.appendNode(id, () => buildSignalNode(id, spec))) as StepDeclaration["signal"];
    const assert: StepDeclaration["assert"] = spec => {
      this.activeScope().nodes.push(buildAssertNode(id, spec));
    };
    const ifStep = ((spec: IfStepSpec<ScopeCallback, ScopeCallback>) =>
      this.appendNode(id, () => buildIfNode(id, spec, this.buildImplicitScope))) as StepDeclaration["if"];
    const switchStep = ((spec: SwitchStepSpec) =>
      this.appendNode(id, () => buildSwitchNode(id, spec, this.buildImplicitScope))) as StepDeclaration["switch"];
    const parallel = ((spec: ParallelStepSpec<Record<string, ScopeCallback>, ParallelStrategy>) =>
      this.appendNode(id, () => buildParallelNode(id, spec, this.buildImplicitScope))) as StepDeclaration["parallel"];
    const fanout = ((spec: FanoutStepSpec<ResolvableArray<any>, unknown, FanoutStrategy>) =>
      this.appendNode(id, () => buildFanoutNode(id, spec, this.buildImplicitScope))) as StepDeclaration["fanout"];
    const loop = ((spec: LoopStepSpec) =>
      this.appendNode(id, () => buildLoopNode(id, spec, this.buildImplicitScope))) as StepDeclaration["loop"];
    return {
      agent,
      task,
      signal,
      assert,
      if: ifStep,
      switch: switchStep,
      parallel,
      fanout,
      loop,
    };
  }

  private readonly buildImplicitScope = <Extra extends object = {}>(
    fn: (ctx: Extra) => unknown,
    extra?: Extra,
  ): ScopeIR => {
    const child: GraphBuildState = { nodes: [] };
    return this.withScope(child, () =>
      buildScopeIR(child, fn, (extra ?? {}) as Extra));
  };

  close(): void {
    this.closed = true;
  }
}

function createAgentRegistry<Agents extends AgentMap | undefined>(agents: Agents): AgentRegistry<Agents> {
  return Object.fromEntries(Object.keys(agents ?? {}).map(key => [key, agentToken(key)])) as AgentRegistry<Agents>;
}

export type CompileWorkflowDefinitionOptions = Readonly<{
  validate?: boolean;
  reusableTasks?: ReusableTaskLinkPlan;
}>;

export type WorkflowCompilationFailure =
  | TaskCompilationFailure
  | {
      type: "workflow-lowering-failed";
      message: string;
      cause: unknown;
    };

export function tryCompileWorkflowDefinition(
  definition: WorkflowDefinition<any, any>,
  options?: CompileWorkflowDefinitionOptions,
): Result<WorkflowIR, WorkflowCompilationFailure> {
  try {
    return ok(lowerWorkflowDefinition(definition, options));
  } catch (cause) {
    if (cause instanceof TaskCompilationAbort) return err(cause.failure);
    return err({
      type: "workflow-lowering-failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}

export function compileWorkflowDefinition(
  definition: WorkflowDefinition<any, any>,
  options?: CompileWorkflowDefinitionOptions,
): WorkflowIR {
  return tryCompileWorkflowDefinition(definition, options).match(
    ir => ir,
    failure => {
      if (failure.type === "workflow-lowering-failed") throw failure.cause;
      throw new Error(failure.message, { cause: failure });
    },
  );
}

function lowerWorkflowDefinition(
  definition: WorkflowDefinition<any, any>,
  options: CompileWorkflowDefinitionOptions | undefined,
): WorkflowIR {
  const diagnostics: DiagnosticIR[] = [];
  const context = new GraphBuildContext(options?.reusableTasks);
  const builder: GraphBuildState = { nodes: [] };
  const input = definition.config.inputSchema ? refExpr<any>(["input"]) : {};
  let output: ExprIR = { kind: "object", fields: {} };
  try {
    context.withScope(builder, () => {
      const result = definition.buildFn({
        input: input as any,
        agents: createAgentRegistry(definition.config.agents),
        meta: refExpr<WorkflowMeta>(["meta"]),
        step: context.step,
      });
      output = outputToIR(result);
    });
  } finally {
    context.close();
  }

  const ir = stripUndefined({
    irVersion: 6,
    name: definition.config.name,
    description: definition.config.description,
    inputSchema: definition.config.inputSchema ? toSchemaIR(definition.config.inputSchema) : undefined,
    agents: lowerAgentDefinitions(definition.config.agents, diagnostics),
    root: { nodes: builder.nodes, output },
    diagnostics,
  }) as WorkflowIR;

  if (options?.validate !== false) ir.diagnostics.push(...validateWorkflowIR(ir));
  return ir;
}
