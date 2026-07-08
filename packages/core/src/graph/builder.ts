import { WORKFLOW } from "../internal/symbols.js";
import { makeNodeRef, refExpr, type NodeRef, type OutputAccessor } from "./refs.js";
import type { WorkflowValue } from "@acpus/expression";
import { toSchemaIR, type InferSchema, type Schema } from "../schema/index.js";
import { agentDefinitionToIR, agentToken, buildAgentNode, type AgentDefinitionSpec, type AgentStepSpec, type AgentToken } from "../nodes/leaf/agent.js";
import { buildTaskNode, type InlineTaskStepSpec, type ReusableTaskStepSpec, type TaskStepSpec } from "../nodes/leaf/task.js";
import { buildSignalNode, type SignalStepSpec } from "../nodes/leaf/signal.js";
import type { RuntimeInput, StepInput } from "../nodes/leaf/shared.js";
import { buildAssertNode, type AssertSpec } from "../nodes/control/assert.js";
import { buildIfNode, type IfStepSpec } from "../nodes/composite/if.js";
import { buildSwitchNode, type SwitchNodeRefOutput, type SwitchStepSpec } from "../nodes/composite/switch.js";
import { buildParallelNode, type ParallelNodeRefOutput, type ParallelStepSpec } from "../nodes/composite/parallel.js";
import { buildFanoutNode, type FanoutNodeRefOutput, type FanoutStepSpec } from "../nodes/composite/fanout.js";
import { buildLoopNode, type LoopStepSpec } from "../nodes/composite/loop.js";
import { buildImplicitScope as buildScopeIR, isOutputObject, type OutputValues, type ScopeContext } from "./scope.js";
import { bindingsToIR, stripUndefined } from "./lowering.js";
import type { FanoutStrategy, OutputObject, ParallelStrategy, RuntimeValueOf, ScopeCallback, WidenRuntimeValue, WorkflowArrayValue } from "../nodes/composite/shared.js";
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
export type { ScopeContext, OutputValue, OutputValues } from "./scope.js";

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
  defaults?: {
    timeout?: string;
  };
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
  input: InputSchema extends Schema<infer Input> ? OutputAccessor<Input> : {};
  agents: AgentRegistry<Agents>;
  meta: OutputAccessor<WorkflowMeta>;
  step: StepFactory;
};

export type BuildFn<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined = undefined> = (ctx: BuildContext<InputSchema, Agents>) => Record<string, unknown>;

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
    build(buildFn: BuildFn<InputSchema, Agents>): WorkflowDefinition<InputSchema, Agents> {
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
  ): NodeRef<InferSchema<OutSchema>>;

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
  ): NodeRef<InferSchema<OutSchema>>;

  signal(
    spec: SignalStepSpec<undefined>,
  ): NodeRef<string>;

  /** Declares an Assert node that fails the run when its condition is false. */
  assert(spec: AssertSpec): void;

  /** Declares a graph-level conditional branch. */
  if<Output extends OutputObject>(
    spec: IfStepSpec<Output>,
  ): NodeRef<RuntimeValueOf<Output>>;

  /** Declares a graph-level switch with explicit cases and a required default branch. */
  switch<const Spec extends SwitchStepSpec>(
    spec: Spec,
  ): NodeRef<SwitchNodeRefOutput<Spec>>;

  /** Declares static parallel branches. Race strategy returns a winner/result envelope. */
  parallel<const Branches extends Record<string, ScopeCallback>>(
    spec: ParallelStepSpec<Branches, "race">,
  ): NodeRef<ParallelNodeRefOutput<Branches, "race">>;

  parallel<const Branches extends Record<string, ScopeCallback>>(
    spec: ParallelStepSpec<Branches, "all">,
  ): NodeRef<ParallelNodeRefOutput<Branches, "all">>;

  /** Declares runtime fanout over a workflow array value. */
  fanout<const Over extends WorkflowArrayValue<any>, Output extends OutputObject>(
    spec: FanoutStepSpec<Over, Output, "quorum">,
  ): NodeRef<FanoutNodeRefOutput<Output, "quorum">>;

  fanout<const Over extends WorkflowArrayValue<any>, Output extends OutputObject>(
    spec: FanoutStepSpec<Over, Output, "all">,
  ): NodeRef<FanoutNodeRefOutput<Output, "all">>;

  /** Declares a seeded pre-check loop with a bounded iteration count. */
  loop<Initial extends OutputObject>(
    spec: LoopStepSpec<Initial>,
  ): NodeRef<WidenRuntimeValue<RuntimeValueOf<Initial>>>;
};

export type StepFactory = (id: string) => StepDeclaration;

class GraphBuildState {
  readonly nodes: NodeIR[] = [];
  readonly step: StepFactory = (id: string) => this.declare(id);

  constructor(private readonly diagnostics: DiagnosticIR[]) {}

  private declare(id: string): StepDeclaration {
    const agent = ((spec: AgentStepSpec<Schema<any> | undefined>) => this.agent(id, spec)) as StepDeclaration["agent"];
    const task = ((spec: TaskStepSpec<StepInput>) => this.task(id, spec as any)) as StepDeclaration["task"];
    const signal = ((spec: SignalStepSpec<Schema<any> | undefined>) => this.signal(id, spec)) as StepDeclaration["signal"];
    const assert: StepDeclaration["assert"] = spec => this.assert(id, spec);
    const ifStep: StepDeclaration["if"] = spec => this.if(id, spec);
    const switchStep: StepDeclaration["switch"] = spec => this.switch(id, spec);
    const parallel = ((spec: ParallelStepSpec<Record<string, ScopeCallback>, ParallelStrategy>) => (
      spec.strategy === "race" ? this.parallel(id, spec) : this.parallel(id, spec)
    )) as unknown as StepDeclaration["parallel"];
    const fanout = ((spec: FanoutStepSpec<WorkflowArrayValue<any>, Record<string, unknown>, FanoutStrategy>) => this.fanout(id, spec as any)) as unknown as StepDeclaration["fanout"];
    const loop: StepDeclaration["loop"] = spec => this.loop(id, spec);
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

  private agent<OutSchema extends Schema<any> | undefined>(
    id: string,
    spec: AgentStepSpec<OutSchema>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : string> {
    this.nodes.push(buildAgentNode(id, spec, this.diagnostics));
    return makeNodeRef(id);
  }

  private task<const Input extends StepInput, Exec extends TaskFunction<RuntimeInput<Input>, any>>(
    id: string,
    spec: InlineTaskStepSpec<Input, Exec>,
  ): NodeRef<Awaited<ReturnType<Exec>>>;

  private task<const Input extends StepInput, TaskInput, Output>(
    id: string,
    spec: ReusableTaskStepSpec<Input, TaskInput, Output> & (RuntimeInput<Input> extends TaskInput ? unknown : never),
  ): NodeRef<Output>;

  private task<const Input extends StepInput>(
    id: string,
    spec: TaskStepSpec<Input>,
  ): NodeRef<any> {
    this.nodes.push(buildTaskNode(id, spec, this.diagnostics));
    return makeNodeRef(id);
  }

  private signal<OutSchema extends Schema<any> | undefined>(
    id: string,
    spec: SignalStepSpec<OutSchema>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : string> {
    this.nodes.push(buildSignalNode(id, spec, this.diagnostics));
    return makeNodeRef(id);
  }

  private assert(id: string, spec: AssertSpec): void {
    this.nodes.push(buildAssertNode(id, spec, this.diagnostics));
  }

  private if<Output extends OutputObject>(
    id: string,
    spec: IfStepSpec<Output>,
  ): NodeRef<RuntimeValueOf<Output>> {
    this.nodes.push(buildIfNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private switch<const Spec extends SwitchStepSpec>(
    id: string,
    spec: Spec,
  ): NodeRef<SwitchNodeRefOutput<Spec>> {
    this.nodes.push(buildSwitchNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private parallel<const Branches extends Record<string, ScopeCallback>>(
    id: string,
    spec: ParallelStepSpec<Branches, "race">,
  ): NodeRef<ParallelNodeRefOutput<Branches, "race">>;

  private parallel<const Branches extends Record<string, ScopeCallback>>(
    id: string,
    spec: ParallelStepSpec<Branches, "all">,
  ): NodeRef<ParallelNodeRefOutput<Branches, "all">>;

  private parallel(
    id: string,
    spec: ParallelStepSpec<Record<string, ScopeCallback>, ParallelStrategy>,
  ): NodeRef<any> {
    this.nodes.push(buildParallelNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private fanout<const Over extends WorkflowArrayValue<any>, Output extends OutputObject>(
    id: string,
    spec: FanoutStepSpec<Over, Output, "quorum">,
  ): NodeRef<FanoutNodeRefOutput<Output, "quorum">>;

  private fanout<const Over extends WorkflowArrayValue<any>, Output extends OutputObject>(
    id: string,
    spec: FanoutStepSpec<Over, Output, "all">,
  ): NodeRef<FanoutNodeRefOutput<Output, "all">>;

  private fanout(
    id: string,
    spec: FanoutStepSpec<WorkflowArrayValue<any>, Record<string, unknown>, FanoutStrategy>,
  ): NodeRef<any> {
    this.nodes.push(buildFanoutNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private loop<Initial extends OutputObject>(
    id: string,
    spec: LoopStepSpec<Initial>,
  ): NodeRef<WidenRuntimeValue<RuntimeValueOf<Initial>>> {
    this.nodes.push(buildLoopNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private readonly buildImplicitScope = <Extra extends object = {}, Output extends OutputObject = OutputObject>(
    fn: (ctx: ScopeContext & Extra) => OutputValues<Output>,
    extra?: Extra,
  ): ScopeIR => {
    const child = new GraphBuildState(this.diagnostics);
    return buildScopeIR(this.diagnostics, child, fn as (ctx: ScopeContext & Extra) => Record<string, unknown>, (extra ?? {}) as Extra);
  };
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
  const builder = new GraphBuildState(diagnostics);
  const input = definition.config.inputSchema ? refExpr<any>(["input"]) : {};
  const result = definition.buildFn({
    input: input as any,
    agents: createAgentRegistry(definition.config.agents),
    meta: refExpr<WorkflowMeta>(["meta"]),
    step: builder.step,
  });
  const validOutput = isOutputObject(result);
  if (!validOutput) {
    diagnostics.push({
      code: "W001",
      severity: "error",
      message: "Workflow build must return an output object.",
      hint: "Return a plain object from the workflow build callback, for example return { result: value }.",
    });
  }

  const ir = stripUndefined({
    irVersion: 2,
    name: definition.config.name,
    description: definition.config.description,
    inputSchema: definition.config.inputSchema ? toSchemaIR(definition.config.inputSchema) : undefined,
    agents: normalizeAgents(definition.config.agents, diagnostics),
    root: { nodes: builder.nodes },
    outputs: validOutput ? bindingsToIR(result) : {},
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
