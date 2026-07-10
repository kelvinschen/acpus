import { WORKFLOW } from "../internal/symbols.js";
import { makeNodeRef, refExpr, type ExprValue, type NodeRef } from "./refs.js";
import type { Resolvable } from "@acpus/expression";
import type { z } from "zod";
import { toSchemaIR, type Schema } from "../schema/index.js";
import { agentDefinitionToIR, agentToken, buildAgentNode, type AgentDefinitionSpec, type AgentStepSpec, type AgentToken } from "../nodes/leaf/agent.js";
import { buildTaskNode, type InlineTaskStepSpec, type ReusableTaskStepSpec, type TaskStepSpec } from "../nodes/leaf/task.js";
import { buildSignalNode, type SignalStepSpec } from "../nodes/leaf/signal.js";
import type { RuntimeInput, StepInput } from "../nodes/leaf/shared.js";
import { buildAssertNode, type AssertSpec } from "../nodes/control/assert.js";
import { buildIfNode, type IfNodeRefOutput, type IfStepSpec } from "../nodes/composite/if.js";
import { buildSwitchNode, type SwitchNodeRefOutput, type SwitchStepSpec } from "../nodes/composite/switch.js";
import { buildParallelNode, type ParallelNodeRefOutput, type ParallelStepSpec } from "../nodes/composite/parallel.js";
import { buildFanoutNode, type FanoutNodeRefOutput, type FanoutStepSpec } from "../nodes/composite/fanout.js";
import { buildLoopNode, type LoopStepSpec, type LoopTransitionOutput } from "../nodes/composite/loop.js";
import { buildImplicitScope as buildScopeIR, isOutputObject, type GraphOutputCheck, type OutputValues } from "./scope.js";
import { bindingsToIR, stripUndefined } from "./lowering.js";
import type { FanoutStrategy, OutputObject, ParallelStrategy, ResolvableArray, RuntimeValueOf, ScopeCallback, WidenRuntimeValue } from "../nodes/composite/shared.js";
import type { TaskFunction } from "../runtime/task-context.js";
import type {
  AgentDefinitionIR,
  DiagnosticIR,
  NodeIR,
  ScopeIR,
  WorkflowIR,
} from "../ir/types.js";
import { validateWorkflowIR } from "../ir/validator.js";

export type { AssertSpec } from "../nodes/control/assert.js";
export type { AgentStepSpec } from "../nodes/leaf/agent.js";
export type { TaskStepSpec } from "../nodes/leaf/task.js";
export type { SignalStepSpec } from "../nodes/leaf/signal.js";
export type { StepInput, GraphInput, RuntimeInput } from "../nodes/leaf/shared.js";
export type { OutputValue, OutputValues } from "./scope.js";

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

export type BuildFn<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined = undefined> = (ctx: BuildContext<InputSchema, Agents>) => Record<string, unknown>;

type CheckedBuildFn<
  InputSchema extends Schema<any> | undefined,
  Agents extends AgentMap | undefined,
  Output extends Record<string, unknown>,
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
    build<const Output extends Record<string, unknown>>(buildFn: CheckedBuildFn<InputSchema, Agents, Output>): WorkflowDefinition<InputSchema, Agents> {
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
  ): NodeRef<Awaited<ReturnType<Exec>>>;

  task<const Input extends StepInput, TaskInput, Output>(
    spec: ReusableTaskStepSpec<Input, TaskInput, Output> & (RuntimeInput<Input> extends TaskInput ? unknown : never),
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
  fanout<const Over extends ResolvableArray<any>, Output extends OutputObject>(
    spec: FanoutStepSpec<Over, Output, "quorum">,
  ): NodeRef<FanoutNodeRefOutput<Output, "quorum">>;

  fanout<const Over extends ResolvableArray<any>, Output extends OutputObject>(
    spec: FanoutStepSpec<Over, Output, "all">,
  ): NodeRef<FanoutNodeRefOutput<Output, "all">>;

  /** Declares a transition-style loop that always executes at least one iteration. */
  loop<Initial extends OutputObject, Transition extends LoopTransitionOutput<Initial>>(
    spec: LoopStepSpec<Initial, Transition>,
  ): NodeRef<WidenRuntimeValue<RuntimeValueOf<Initial>>>;
};

export type StepFactory = (id: string) => StepDeclaration;

class GraphBuildState {
  readonly nodes: NodeIR[] = [];
  readonly step: StepFactory;

  constructor(private readonly context: GraphBuildContext) {
    this.step = context.step;
  }

  agent<OutSchema extends Schema<any> | undefined>(
    id: string,
    spec: AgentStepSpec<OutSchema>,
  ): NodeRef<OutSchema extends Schema<any> ? z.output<OutSchema> : string> {
    this.nodes.push(buildAgentNode(id, spec, this.context.diagnostics));
    return makeNodeRef(id);
  }

  task<const Input extends StepInput, Exec extends TaskFunction<RuntimeInput<Input>, any>>(
    id: string,
    spec: InlineTaskStepSpec<Input, Exec>,
  ): NodeRef<Awaited<ReturnType<Exec>>>;

  task<const Input extends StepInput, TaskInput, Output>(
    id: string,
    spec: ReusableTaskStepSpec<Input, TaskInput, Output> & (RuntimeInput<Input> extends TaskInput ? unknown : never),
  ): NodeRef<Output>;

  task<const Input extends StepInput>(
    id: string,
    spec: TaskStepSpec<Input>,
  ): NodeRef<any> {
    this.nodes.push(buildTaskNode(id, spec, this.context.diagnostics));
    return makeNodeRef(id);
  }

  signal<OutSchema extends Schema<any> | undefined>(
    id: string,
    spec: SignalStepSpec<OutSchema>,
  ): NodeRef<OutSchema extends Schema<any> ? z.output<OutSchema> : string> {
    this.nodes.push(buildSignalNode(id, spec, this.context.diagnostics));
    return makeNodeRef(id);
  }

  assert(id: string, spec: AssertSpec): void {
    this.nodes.push(buildAssertNode(id, spec, this.context.diagnostics));
  }

  if<const Then extends ScopeCallback, const Else extends ScopeCallback>(
    id: string,
    spec: IfStepSpec<Then, Else>,
  ): NodeRef<IfNodeRefOutput<Then, Else>> {
    this.nodes.push(buildIfNode(id, spec, this.context.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  switch<const Cases extends ReadonlyArray<{ when: Resolvable<boolean>; then: ScopeCallback }>, const Default extends ScopeCallback>(
    id: string,
    spec: SwitchStepSpec<Cases, Default>,
  ): NodeRef<SwitchNodeRefOutput<Cases, Default>> {
    this.nodes.push(buildSwitchNode(id, spec, this.context.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  parallel<const Branches extends Record<string, ScopeCallback>>(
    id: string,
    spec: ParallelStepSpec<Branches, "race">,
  ): NodeRef<ParallelNodeRefOutput<Branches, "race">>;

  parallel<const Branches extends Record<string, ScopeCallback>>(
    id: string,
    spec: ParallelStepSpec<Branches, "all">,
  ): NodeRef<ParallelNodeRefOutput<Branches, "all">>;

  parallel(
    id: string,
    spec: ParallelStepSpec<Record<string, ScopeCallback>, ParallelStrategy>,
  ): NodeRef<any> {
    this.nodes.push(buildParallelNode(id, spec, this.context.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  fanout<const Over extends ResolvableArray<any>, Output extends OutputObject>(
    id: string,
    spec: FanoutStepSpec<Over, Output, "quorum">,
  ): NodeRef<FanoutNodeRefOutput<Output, "quorum">>;

  fanout<const Over extends ResolvableArray<any>, Output extends OutputObject>(
    id: string,
    spec: FanoutStepSpec<Over, Output, "all">,
  ): NodeRef<FanoutNodeRefOutput<Output, "all">>;

  fanout(
    id: string,
    spec: FanoutStepSpec<ResolvableArray<any>, any, FanoutStrategy>,
  ): NodeRef<any> {
    this.nodes.push(buildFanoutNode(id, spec, this.context.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  loop<Initial extends OutputObject, Transition extends LoopTransitionOutput<Initial>>(
    id: string,
    spec: LoopStepSpec<Initial, Transition>,
  ): NodeRef<WidenRuntimeValue<RuntimeValueOf<Initial>>> {
    this.nodes.push(buildLoopNode(id, spec, this.context.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private readonly buildImplicitScope = <Extra extends object = {}, Output extends OutputObject = OutputObject>(
    fn: (ctx: Extra) => OutputValues<Output>,
    extra?: Extra,
  ): ScopeIR => {
    const child = new GraphBuildState(this.context);
    return this.context.withScope(child, () =>
      buildScopeIR(this.context.diagnostics, child, fn as (ctx: Extra) => Record<string, unknown>, (extra ?? {}) as Extra));
  };
}

class GraphBuildContext {
  private readonly scopes: GraphBuildState[] = [];
  private closed = false;

  readonly step: StepFactory = (id: string) => this.declare(id);

  constructor(readonly diagnostics: DiagnosticIR[]) {}

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

  private withActiveDeclaration<T>(fn: (scope: GraphBuildState) => T): T {
    return fn(this.activeScope());
  }

  private declare(id: string): StepDeclaration {
    this.activeScope();
    const agent = ((spec: AgentStepSpec<Schema<any> | undefined>) => this.withActiveDeclaration(scope => scope.agent(id, spec))) as StepDeclaration["agent"];
    const task = ((spec: TaskStepSpec<StepInput>) => this.withActiveDeclaration(scope => scope.task(id, spec as any))) as StepDeclaration["task"];
    const signal = ((spec: SignalStepSpec<Schema<any> | undefined>) => this.withActiveDeclaration(scope => scope.signal(id, spec))) as StepDeclaration["signal"];
    const assert: StepDeclaration["assert"] = spec => this.withActiveDeclaration(scope => scope.assert(id, spec));
    const ifStep: StepDeclaration["if"] = spec => this.withActiveDeclaration(scope => scope.if(id, spec));
    const switchStep: StepDeclaration["switch"] = spec => this.withActiveDeclaration(scope => scope.switch(id, spec));
    const parallel = ((spec: ParallelStepSpec<Record<string, ScopeCallback>, ParallelStrategy>) =>
      this.withActiveDeclaration(scope => scope.parallel(id, spec as any))) as unknown as StepDeclaration["parallel"];
    const fanout = ((spec: FanoutStepSpec<ResolvableArray<any>, any, FanoutStrategy>) =>
      this.withActiveDeclaration(scope => scope.fanout(id, spec as any))) as unknown as StepDeclaration["fanout"];
    const loop: StepDeclaration["loop"] = spec => this.withActiveDeclaration(scope => scope.loop(id, spec));
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

  close(): void {
    this.closed = true;
  }
}

function normalizeAgents(agents: AgentMap | undefined, diagnostics: DiagnosticIR[]): Record<string, AgentDefinitionIR> {
  const out: Record<string, AgentDefinitionIR> = {};
  for (const [name, value] of Object.entries((agents ?? {}) as Record<string, unknown>)) {
    const agent = normalizeAgentDefinition(name, value, diagnostics);
    if (agent) out[name] = agent;
  }
  return out;
}

function createAgentRegistry<Agents extends AgentMap | undefined>(agents: Agents): AgentRegistry<Agents> {
  return Object.fromEntries(Object.keys(agents ?? {}).map(key => [key, agentToken(key)])) as AgentRegistry<Agents>;
}

function normalizeAgentDefinition(name: string, value: unknown, diagnostics: DiagnosticIR[]): AgentDefinitionIR | undefined {
  const path = `agents.${name}`;
  if (!isRecord(value)) {
    invalidAgentDefinition(diagnostics, path, `Agent '${name}' definition must be an object.`);
    return undefined;
  }
  if (value.kind !== undefined) {
    invalidAgentDefinition(diagnostics, `${path}.kind`, `Agent '${name}' definition must be a plain authoring spec, not an IR object.`);
    return undefined;
  }

  const hasUse = value.use !== undefined;
  const hasCommand = value.command !== undefined;
  if (hasUse === hasCommand) {
    invalidAgentDefinition(diagnostics, path, `Agent '${name}' definition must set exactly one of use or command.`);
    return undefined;
  }
  let invalid = false;
  const reject = (fieldPath: string, message: string) => {
    invalid = true;
    invalidAgentDefinition(diagnostics, fieldPath, message);
  };
  if (value.policy !== undefined) reject(`${path}.policy`, `Agent '${name}' definition must use permissionMode, not policy.`);
  if (value.options !== undefined) reject(`${path}.options`, `Agent '${name}' definition must not set options.`);
  if (value.agentMode !== undefined && (typeof value.agentMode !== "string" || value.agentMode.length === 0)) {
    reject(`${path}.agentMode`, `Agent '${name}' agentMode must be a non-empty string.`);
  }
  if (value.permissionMode !== undefined && value.permissionMode !== "approve-reads" && value.permissionMode !== "approve-all" && value.permissionMode !== "deny-all") {
    reject(`${path}.permissionMode`, `Agent '${name}' permissionMode must be approve-reads, approve-all, or deny-all.`);
  }
  if (invalid) return undefined;

  if (hasUse) {
    if (typeof value.use !== "string" || value.use.length === 0) {
      invalidAgentDefinition(diagnostics, `${path}.use`, `Agent '${name}' use must be a non-empty string.`);
      return undefined;
    }
    return agentDefinitionToIR(value as AgentDefinitionSpec);
  }

  if (typeof value.command !== "string" || value.command.length === 0) {
    invalidAgentDefinition(diagnostics, `${path}.command`, `Agent '${name}' command must be a non-empty string.`);
    return undefined;
  }
  return agentDefinitionToIR(value as AgentDefinitionSpec);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function invalidAgentDefinition(diagnostics: DiagnosticIR[], path: string, message: string): void {
  diagnostics.push({ code: "A002", severity: "error", message, path });
}

export function compileWorkflowDefinition(definition: WorkflowDefinition<any, any>, options?: { source?: string; validate?: boolean }): WorkflowIR {
  const diagnostics: DiagnosticIR[] = [];
  const context = new GraphBuildContext(diagnostics);
  const builder = new GraphBuildState(context);
  const input = definition.config.inputSchema ? refExpr<any>(["input"]) : {};
  let loweredOutputs: Record<string, any> = {};
  try {
    context.withScope(builder, () => {
      const result = definition.buildFn({
        input: input as any,
        agents: createAgentRegistry(definition.config.agents),
        meta: refExpr<WorkflowMeta>(["meta"]),
        step: context.step,
      });
      const validOutput = isOutputObject(result);
      if (!validOutput) {
        diagnostics.push({
          code: "W001",
          severity: "error",
          message: "Workflow build must return an output object.",
          hint: "Return a plain object from the workflow build callback, for example return { result: value }.",
        });
        return;
      }
      loweredOutputs = bindingsToIR(result);
    });
  } finally {
    context.close();
  }

  const ir = stripUndefined({
    irVersion: 3,
    name: definition.config.name,
    description: definition.config.description,
    inputSchema: definition.config.inputSchema ? toSchemaIR(definition.config.inputSchema) : undefined,
    agents: normalizeAgents(definition.config.agents, diagnostics),
    root: { nodes: builder.nodes },
    outputs: loweredOutputs,
    lock: {
      acpusCoreVersion: "0.3.0-core-alpha",
      workflowSource: options?.source,
      generatedAt: new Date().toISOString(),
      notes: [
        "Workflow definition was lowered into Acpus IR.",
        "Production module compilation attaches reusable task module references before workflow admission.",
      ],
    },
    diagnostics,
  }) as WorkflowIR;

  if (options?.validate !== false) ir.diagnostics.push(...validateWorkflowIR(ir));
  return ir;
}
