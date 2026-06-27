import { WORKFLOW } from "../internal/symbols.js";
import { valueToExprIR } from "../expressions/expr.js";
import { makeNodeRef, refExpr, type NodeRef, type OutputAccessor } from "./refs.js";
import { toSchemaIR, type InferSchema, type Schema } from "../schema/index.js";
import { agent, type AgentDefinition } from "../nodes/leaf/agent.js";
import { buildAgentNode, type AgentStepSpec } from "../nodes/leaf/agent.js";
import { buildTaskNode, type TaskStepSpec } from "../nodes/leaf/task.js";
import { buildSignalNode, type SignalStepSpec } from "../nodes/leaf/signal.js";
import { buildGuardNode, type GuardSpec } from "../nodes/control/guard.js";
import { buildIfNode, type IfStepSpec } from "../nodes/composite/if.js";
import { buildSwitchNode, type SwitchStepSpec } from "../nodes/composite/switch.js";
import { buildParallelNode, type ParallelStepSpec } from "../nodes/composite/parallel.js";
import { buildFanoutNode, type FanoutNodeRefOutput, type FanoutStepSpec } from "../nodes/composite/fanout.js";
import { buildLoopNode, type LoopStepSpec } from "../nodes/composite/loop.js";
import { buildImplicitScope as buildScopeIR, isOutputToken, makeOutputToken, type OutputHelper, type OutputToken, type ScopeContext } from "./scope.js";
import { stripUndefined } from "./lowering.js";
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

export type { AgentStepSpec } from "../nodes/leaf/agent.js";
export type { TaskStepSpec } from "../nodes/leaf/task.js";
export type { SignalStepSpec } from "../nodes/leaf/signal.js";
export type { StepInput, GraphInput, RuntimeInput } from "../nodes/leaf/shared.js";
export type { GuardSpec } from "../nodes/control/guard.js";
export type { ScopeContext, OutputHelper, OutputToken } from "./scope.js";

export type AgentMap = Record<string, AgentDefinition | AgentDefinitionIR>;

export type WorkflowConfig<InputSchema extends Schema<any> | undefined, Agents extends AgentMap> = {
  name: string;
  input?: InputSchema;
  agents?: Agents;
  defaults?: {
    timeout?: string;
    retry?: RetryIR;
  };
};

export type WorkflowDefinition<InputSchema extends Schema<any> | undefined, Agents extends AgentMap> = {
  readonly [WORKFLOW]: true;
  readonly config: WorkflowConfig<InputSchema, Agents>;
  readonly buildFn: BuildFn<InputSchema>;
};

export type BuildContext<InputSchema extends Schema<any> | undefined> = {
  input: InputSchema extends Schema<infer Input> ? OutputAccessor<Input> : Record<string, never>;
  step: StepBuilder;
  output: OutputHelper;
  workflow: { name: string };
};

export type BuildFn<InputSchema extends Schema<any> | undefined> = (ctx: BuildContext<InputSchema>) => OutputToken<any>;

export function defineWorkflow<InputSchema extends Schema<any> | undefined = undefined, Agents extends AgentMap = AgentMap>(config: WorkflowConfig<InputSchema, Agents>) {
  return {
    build(buildFn: BuildFn<InputSchema>): WorkflowDefinition<InputSchema, Agents> {
      return { [WORKFLOW]: true as const, config, buildFn };
    },
  };
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition<any, any> {
  return Boolean(value && typeof value === "object" && (value as any)[WORKFLOW]);
}

export class StepBuilder {
  readonly nodes: NodeIR[] = [];
  constructor(private readonly taskBundles: Record<string, TaskBundleIR>, private readonly diagnostics: DiagnosticIR[]) {}

  agent<const Input extends Record<string, unknown>, OutSchema extends Schema<any> | undefined>(
    id: string,
    spec: AgentStepSpec<Input, OutSchema>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown> {
    this.nodes.push(buildAgentNode(id, spec, this.diagnostics));
    return makeNodeRef(id);
  }

  task<const Input extends Record<string, unknown>, OutSchema extends Schema<any>>(
    id: string,
    spec: TaskStepSpec<Input, OutSchema>,
  ): NodeRef<InferSchema<OutSchema>> {
    this.nodes.push(buildTaskNode(id, spec, this.taskBundles, this.diagnostics));
    return makeNodeRef(id);
  }

  signal<const Input extends Record<string, unknown>, OutSchema extends Schema<any>>(
    id: string,
    spec: SignalStepSpec<Input, OutSchema>,
  ): NodeRef<InferSchema<OutSchema>> {
    this.nodes.push(buildSignalNode(id, spec, this.diagnostics));
    return makeNodeRef(id);
  }

  guard(id: string, spec: GuardSpec): void {
    this.nodes.push(buildGuardNode(id, spec, this.diagnostics));
  }

  if<OutSchema extends Schema<any> | undefined>(
    id: string,
    spec: IfStepSpec<OutSchema>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown> {
    this.nodes.push(buildIfNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  switch<OutSchema extends Schema<any> | undefined>(
    id: string,
    spec: SwitchStepSpec<OutSchema>,
  ): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown> {
    this.nodes.push(buildSwitchNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  parallel<Branches extends Record<string, (ctx: ScopeContext) => OutputToken<any>>>(
    id: string,
    spec: ParallelStepSpec<Branches>,
  ): NodeRef<{ [K in keyof Branches]: unknown }> {
    this.nodes.push(buildParallelNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  fanout<OutSchema extends Schema<any> | undefined>(
    id: string,
    spec: FanoutStepSpec<OutSchema>,
  ): NodeRef<FanoutNodeRefOutput<OutSchema>> {
    this.nodes.push(buildFanoutNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  loop<OutSchema extends Schema<any>>(
    id: string,
    spec: LoopStepSpec<OutSchema>,
  ): NodeRef<InferSchema<OutSchema>> {
    this.nodes.push(buildLoopNode(id, spec, this.diagnostics, this.buildImplicitScope));
    return makeNodeRef(id);
  }

  private readonly buildImplicitScope = <Extra extends object = {}>(
    fn: (ctx: ScopeContext & Extra) => OutputToken<any>,
    extra?: Extra,
  ): ScopeIR => {
    const child = new StepBuilder(this.taskBundles, this.diagnostics);
    return buildScopeIR(this.diagnostics, child, fn, (extra ?? {}) as Extra);
  };
}

function normalizeAgents(agents: AgentMap | undefined): Record<string, AgentDefinitionIR> {
  const out: Record<string, AgentDefinitionIR> = {};
  for (const [name, value] of Object.entries(agents ?? {})) {
    out[name] = agent.isDefinition(value) ? value.ir : value as AgentDefinitionIR;
  }
  return out;
}

export function compileWorkflowDefinition(definition: WorkflowDefinition<any, any>, options?: { source?: string }): WorkflowIR {
  const diagnostics: DiagnosticIR[] = [];
  const taskBundles: Record<string, TaskBundleIR> = {};
  const step = new StepBuilder(taskBundles, diagnostics);
  const input = definition.config.input ? refExpr<any>(["input"]) : {};
  const result = definition.buildFn({ input: input as any, step, output: makeOutputToken, workflow: { name: definition.config.name } });
  if (!isOutputToken(result)) diagnostics.push({ code: "W001", severity: "error", message: "Workflow build must return output({...})." });

  const ir = stripUndefined({
    irVersion: 2,
    name: definition.config.name,
    inputSchema: definition.config.input ? toSchemaIR(definition.config.input) : undefined,
    agents: normalizeAgents(definition.config.agents),
    root: { nodes: step.nodes },
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
