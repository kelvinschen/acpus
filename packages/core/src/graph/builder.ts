import { WORKFLOW } from "../internal/symbols.js";
import { valueToExprIR } from "../expressions/expr.js";
import { makeNodeRef, refExpr, type NodeRef, type OutputAccessor } from "./refs.js";
import { toSchemaIR, type InferSchema, type Schema } from "../schema/index.js";
import { agentDefinitionToIR, buildAgentNode, type AgentDefinitionSpec, type AgentStepSpec } from "../nodes/leaf/agent.js";
import { buildTaskNode, type InlineTaskStepSpec, type ReusableTaskStepSpec, type TaskStepSpec } from "../nodes/leaf/task.js";
import { buildSignalNode, type SignalStepSpec } from "../nodes/leaf/signal.js";
import type { RuntimeInput, StepInput } from "../nodes/leaf/shared.js";
import { buildAssertNode, type AssertSpec } from "../nodes/control/assert.js";
import { buildIfNode, type IfStepSpec } from "../nodes/composite/if.js";
import { buildSwitchNode, type SwitchStepSpec } from "../nodes/composite/switch.js";
import { buildParallelNode, type ParallelNodeRefOutput, type ParallelStepSpec } from "../nodes/composite/parallel.js";
import { buildFanoutNode, type FanoutNodeRefOutput, type FanoutStepSpec } from "../nodes/composite/fanout.js";
import { buildLoopNode, type LoopStepSpec } from "../nodes/composite/loop.js";
import { buildImplicitScope as buildScopeIR, isOutputToken, makeOutputToken, type OutputHelper, type OutputToken, type ScopeContext, type ScopeIdentity } from "./scope.js";
import { stripUndefined } from "./lowering.js";
import type { FanoutStrategy, ObjectSchema, ParallelStrategy, WorkflowArrayValue } from "../nodes/composite/shared.js";
import type {
  AgentDefinitionIR,
  DiagnosticIR,
  NodeIR,
  RetryIR,
  ScopeIR,
  TaskBundleIR,
  WorkflowIR,
} from "../ir/types.js";
import { validateWorkflowIR } from "../ir/validator.js";

export type { AssertSpec } from "../nodes/control/assert.js";
export type { AgentStepSpec } from "../nodes/leaf/agent.js";
export type { TaskStepSpec } from "../nodes/leaf/task.js";
export type { SignalStepSpec } from "../nodes/leaf/signal.js";
export type { StepInput, GraphInput, RuntimeInput } from "../nodes/leaf/shared.js";
export type { ScopeContext, OutputHelper, OutputToken, OutputValue, OutputValues, TypedOutputHelper } from "./scope.js";

export type AgentMap = Record<string, AgentDefinitionSpec>;
type AgentKeyOf<Agents extends AgentMap | undefined> = Agents extends AgentMap ? Extract<keyof Agents, string> : never;

export type WorkflowConfig<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined> = {
  name: string;
  inputSchema?: InputSchema;
  agents?: Agents;
  defaults?: {
    timeout?: string;
    retry?: RetryIR;
  };
};

export type WorkflowDefinition<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined> = {
  readonly [WORKFLOW]: true;
  readonly config: WorkflowConfig<InputSchema, Agents>;
  readonly buildFn: BuildFn<InputSchema, Agents>;
};

export type BuildContext<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined = undefined> = {
  input: InputSchema extends Schema<infer Input> ? OutputAccessor<Input> : {};
  step: StepFactory<AgentKeyOf<Agents>>;
  output: OutputHelper;
  workflow: { name: string };
};

export type BuildFn<InputSchema extends Schema<any> | undefined, Agents extends AgentMap | undefined = undefined> = (ctx: BuildContext<InputSchema, Agents>) => OutputToken<any, any>;

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

export type StepDeclaration<AgentKey extends string = never> = {
  agent<OutSchema extends Schema<any> | undefined>(
    spec: AgentStepSpec<OutSchema, AgentKey>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown>;

  task<const Input extends StepInput, OutSchema extends Schema<any>>(
    spec: InlineTaskStepSpec<Input, OutSchema>,
  ): NodeRef<InferSchema<OutSchema>>;

  task<const Input extends StepInput, TaskInput, Output>(
    spec: ReusableTaskStepSpec<Input, TaskInput, Output> & (RuntimeInput<Input> extends TaskInput ? unknown : never),
  ): NodeRef<Output>;

  signal<OutSchema extends Schema<any>>(
    spec: SignalStepSpec<OutSchema>,
  ): NodeRef<InferSchema<OutSchema>>;

  assert(spec: AssertSpec): void;

  if<OutSchema extends ObjectSchema | undefined>(
    spec: IfStepSpec<OutSchema, AgentKey>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown>;

  switch<OutSchema extends ObjectSchema | undefined>(
    spec: SwitchStepSpec<OutSchema, AgentKey>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown>;

  parallel<const Branches extends Record<string, ObjectSchema>>(
    spec: ParallelStepSpec<Branches, "race", AgentKey>,
  ): NodeRef<ParallelNodeRefOutput<Branches, "race">>;

  parallel<const Branches extends Record<string, ObjectSchema>>(
    spec: ParallelStepSpec<Branches, "all", AgentKey>,
  ): NodeRef<ParallelNodeRefOutput<Branches, "all">>;

  fanout<const Over extends WorkflowArrayValue<any>, OutSchema extends ObjectSchema>(
    spec: FanoutStepSpec<Over, OutSchema, "quorum", AgentKey>,
  ): NodeRef<FanoutNodeRefOutput<OutSchema, "quorum">>;

  fanout<const Over extends WorkflowArrayValue<any>, OutSchema extends ObjectSchema>(
    spec: FanoutStepSpec<Over, OutSchema, "all", AgentKey>,
  ): NodeRef<FanoutNodeRefOutput<OutSchema, "all">>;

  loop<OutSchema extends ObjectSchema>(
    spec: LoopStepSpec<OutSchema, AgentKey>,
  ): NodeRef<InferSchema<OutSchema>>;
};

export type StepFactory<AgentKey extends string = never> = (id: string) => StepDeclaration<AgentKey>;

class GraphBuildState<AgentKey extends string = string> {
  readonly nodes: NodeIR[] = [];
  readonly step: StepFactory<AgentKey> = (id: string) => this.declare(id);

  constructor(private readonly taskBundles: Record<string, TaskBundleIR>, private readonly diagnostics: DiagnosticIR[]) {}

  private declare(id: string): StepDeclaration<AgentKey> {
    const agent: StepDeclaration<AgentKey>["agent"] = spec => this.agent(id, spec);
    const task = ((spec: TaskStepSpec<StepInput>) => this.task(id, spec as any)) as StepDeclaration<AgentKey>["task"];
    const signal: StepDeclaration<AgentKey>["signal"] = spec => this.signal(id, spec);
    const assert: StepDeclaration<AgentKey>["assert"] = spec => this.assert(id, spec);
    const ifStep: StepDeclaration<AgentKey>["if"] = spec => this.if(id, spec);
    const switchStep: StepDeclaration<AgentKey>["switch"] = spec => this.switch(id, spec);
    const parallel = ((spec: ParallelStepSpec<Record<string, ObjectSchema>, ParallelStrategy, AgentKey>) => this.parallel(id, spec as any)) as unknown as StepDeclaration<AgentKey>["parallel"];
    const fanout = ((spec: FanoutStepSpec<WorkflowArrayValue<any>, ObjectSchema, FanoutStrategy, AgentKey>) => this.fanout(id, spec as any)) as unknown as StepDeclaration<AgentKey>["fanout"];
    const loop: StepDeclaration<AgentKey>["loop"] = spec => this.loop(id, spec);
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
    spec: AgentStepSpec<OutSchema, AgentKey>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown> {
    this.nodes.push(buildAgentNode(id, spec, this.diagnostics));
    return makeNodeRef(id);
  }

  private task<const Input extends StepInput, OutSchema extends Schema<any>>(
    id: string,
    spec: InlineTaskStepSpec<Input, OutSchema>,
  ): NodeRef<InferSchema<OutSchema>>;

  private task<const Input extends StepInput, TaskInput, Output>(
    id: string,
    spec: ReusableTaskStepSpec<Input, TaskInput, Output> & (RuntimeInput<Input> extends TaskInput ? unknown : never),
  ): NodeRef<Output>;

  private task<const Input extends StepInput>(
    id: string,
    spec: TaskStepSpec<Input>,
  ): NodeRef<any> {
    this.nodes.push(buildTaskNode(id, spec, this.taskBundles, this.diagnostics));
    return makeNodeRef(id);
  }

  private signal<OutSchema extends Schema<any>>(
    id: string,
    spec: SignalStepSpec<OutSchema>,
  ): NodeRef<InferSchema<OutSchema>> {
    this.nodes.push(buildSignalNode(id, spec, this.diagnostics));
    return makeNodeRef(id);
  }

  private assert(id: string, spec: AssertSpec): void {
    this.nodes.push(buildAssertNode(id, spec, this.diagnostics));
  }

  private if<OutSchema extends ObjectSchema | undefined>(
    id: string,
    spec: IfStepSpec<OutSchema, AgentKey>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown> {
    this.nodes.push(buildIfNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private switch<OutSchema extends ObjectSchema | undefined>(
    id: string,
    spec: SwitchStepSpec<OutSchema, AgentKey>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown> {
    this.nodes.push(buildSwitchNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private parallel<const Branches extends Record<string, ObjectSchema>>(
    id: string,
    spec: ParallelStepSpec<Branches, "race", AgentKey>,
  ): NodeRef<ParallelNodeRefOutput<Branches, "race">>;

  private parallel<const Branches extends Record<string, ObjectSchema>>(
    id: string,
    spec: ParallelStepSpec<Branches, "all", AgentKey>,
  ): NodeRef<ParallelNodeRefOutput<Branches, "all">>;

  private parallel(
    id: string,
    spec: ParallelStepSpec<Record<string, ObjectSchema>, ParallelStrategy, AgentKey>,
  ): NodeRef<any> {
    this.nodes.push(buildParallelNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private fanout<const Over extends WorkflowArrayValue<any>, OutSchema extends ObjectSchema>(
    id: string,
    spec: FanoutStepSpec<Over, OutSchema, "quorum", AgentKey>,
  ): NodeRef<FanoutNodeRefOutput<OutSchema, "quorum">>;

  private fanout<const Over extends WorkflowArrayValue<any>, OutSchema extends ObjectSchema>(
    id: string,
    spec: FanoutStepSpec<Over, OutSchema, "all", AgentKey>,
  ): NodeRef<FanoutNodeRefOutput<OutSchema, "all">>;

  private fanout(
    id: string,
    spec: FanoutStepSpec<WorkflowArrayValue<any>, ObjectSchema, FanoutStrategy, AgentKey>,
  ): NodeRef<any> {
    this.nodes.push(buildFanoutNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private loop<OutSchema extends ObjectSchema>(
    id: string,
    spec: LoopStepSpec<OutSchema, AgentKey>,
  ): NodeRef<InferSchema<OutSchema>> {
    this.nodes.push(buildLoopNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private readonly buildImplicitScope = <Extra extends object = {}, Output extends object = Record<string, unknown>>(
    fn: <Scope extends ScopeIdentity>(ctx: ScopeContext<Output, AgentKey, Scope> & Extra) => ReturnType<ScopeContext<Output, AgentKey, Scope>["output"]>,
    extra?: Extra,
  ): ScopeIR => {
    const child = new GraphBuildState<AgentKey>(this.taskBundles, this.diagnostics);
    return buildScopeIR(this.diagnostics, child, fn, (extra ?? {}) as Extra);
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
  if (value.model !== undefined) {
    invalidAgentDefinition(diagnostics, `${path}.model`, `Command-backed agent '${name}' must not set model.`);
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

export function compileWorkflowDefinition(definition: WorkflowDefinition<any, any>, options?: { source?: string }): WorkflowIR {
  const diagnostics: DiagnosticIR[] = [];
  const taskBundles: Record<string, TaskBundleIR> = {};
  const builder = new GraphBuildState(taskBundles, diagnostics);
  const input = definition.config.inputSchema ? refExpr<any>(["input"]) : {};
  const result = definition.buildFn({ input: input as any, step: builder.step, output: makeOutputToken, workflow: { name: definition.config.name } });
  if (!isOutputToken(result)) diagnostics.push({ code: "W001", severity: "error", message: "Workflow build must return output({...})." });

  const ir = stripUndefined({
    irVersion: 2,
    name: definition.config.name,
    inputSchema: definition.config.inputSchema ? toSchemaIR(definition.config.inputSchema) : undefined,
    agents: normalizeAgents(definition.config.agents, diagnostics),
    root: { nodes: builder.nodes },
    outputs: result?.ir ?? {},
    assets: { taskBundles },
    lock: {
      acpusCoreVersion: "0.3.0-core-alpha",
      workflowSource: options?.source,
      taskBundleDigests: Object.fromEntries(Object.entries(taskBundles).map(([id, bundle]) => [id, bundle.digest])),
      generatedAt: new Date().toISOString(),
      notes: [
        "Core-alpha compiler executes workflow modules as trusted code.",
        "Core-alpha task source capture is not production bundling; see docs/ROADMAP.md.",
      ],
    },
    diagnostics,
  }) as WorkflowIR;

  ir.diagnostics.push(...validateWorkflowIR(ir));
  return ir;
}
