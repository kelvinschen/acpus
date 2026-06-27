import { WORKFLOW, OUTPUT_TOKEN } from "./internal.js";
import { makeNodeRef, refExpr, valueToExprIR, type Expr, type NodeRef, type OutputAccessor } from "./expr.js";
import { toSchemaIR, type InferSchema, type Schema } from "./schema.js";
import { templateToIR, type Template } from "./template.js";
import { task, type TaskToken } from "./task.js";
import { agent, type AgentDefinition, type AgentRun } from "./agent.js";
import { signal, type SignalRun } from "./signal.js";
import { secretOrExprToIR } from "./runtime.js";
import type {
  AgentDefinitionIR,
  AgentNodeIR,
  DiagnosticIR,
  ExprIR,
  FanoutNodeIR,
  GuardNodeIR,
  IfNodeIR,
  JsonObject,
  LoopNodeIR,
  NodeIR,
  ParallelNodeIR,
  RetryIR,
  ScopeIR,
  SignalNodeIR,
  SwitchNodeIR,
  TaskBundleIR,
  TaskNodeIR,
  WorkflowIR,
} from "./ir.js";
import { validateWorkflowIR } from "./validator.js";

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

export type OutputToken<T> = {
  readonly [OUTPUT_TOKEN]: true;
  readonly values: T;
  readonly ir: Record<string, ExprIR>;
};

export type OutputHelper = <T extends Record<string, unknown>>(values: T) => OutputToken<T>;

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

export type AgentStepSpec<OutSchema extends Schema<any> | undefined = Schema<any> | undefined> = {
  input?: Record<string, unknown>;
  output?: OutSchema;
  run: AgentRun;
  timeout?: string;
  retry?: RetryIR;
};

export type TaskStepSpec<OutSchema extends Schema<any>> = {
  input?: Record<string, unknown>;
  output: OutSchema;
  run: TaskToken<any, InferSchema<OutSchema>, any>;
  params?: JsonObject;
  cwd?: unknown;
  env?: Record<string, unknown>;
  timeout?: string;
  retry?: RetryIR;
  execution?: {
    shell?: "bash" | "powershell" | "pwsh";
    defaultCommandTimeout?: string;
    commandRunner?: "acpus-zx-core" | "custom";
  };
};

export type SignalStepSpec<OutSchema extends Schema<any>> = {
  input?: Record<string, unknown>;
  output: OutSchema;
  run: SignalRun;
  timeout?: string;
  onTimeout?: { action: "fail" | "complete"; message?: string };
};

export type GuardSpec = {
  when: unknown;
  then?: "continue" | "fail" | "complete";
  otherwise: "continue" | "fail" | "complete";
  message?: Template | string;
};

export type BranchContext = {
  step: StepBuilder;
  output: OutputHelper;
};

function makeOutputToken<T extends Record<string, unknown>>(values: T): OutputToken<T> {
  const ir: Record<string, ExprIR> = {};
  for (const [key, value] of Object.entries(values)) ir[key] = valueToExprIR(value);
  return { [OUTPUT_TOKEN]: true as const, values, ir };
}

function isOutputToken(value: unknown): value is OutputToken<any> {
  return Boolean(value && typeof value === "object" && (value as any)[OUTPUT_TOKEN]);
}

function inputsToIR(input?: Record<string, unknown>): Record<string, ExprIR> {
  const result: Record<string, ExprIR> = {};
  for (const [key, value] of Object.entries(input ?? {})) result[key] = valueToExprIR(value);
  return result;
}

function makeInputRuntimeObject(input?: Record<string, unknown>): Record<string, unknown> {
  return input ?? {};
}

function envToIR(env?: Record<string, unknown>): Record<string, any> | undefined {
  if (!env) return undefined;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(env)) out[key] = secretOrExprToIR(value);
  return out;
}


function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = stripUndefined(item);
    }
    return out as T;
  }
  return value;
}

export class StepBuilder {
  readonly nodes: NodeIR[] = [];
  constructor(private readonly taskBundles: Record<string, TaskBundleIR>, private readonly diagnostics: DiagnosticIR[]) {}

  agent<OutSchema extends Schema<any> | undefined>(id: string, spec: AgentStepSpec<OutSchema>): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown> {
    assertStableId(id, this.diagnostics);
    if (!agent.isRun(spec.run)) this.diagnostics.push({ code: "A000", severity: "error", message: `Agent node '${id}' must use run: agent({...}).` });
    const inputValues = makeInputRuntimeObject(spec.input);
    const node = stripUndefined({
      id,
      kind: "agent",
      inputs: inputsToIR(spec.input),
      outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
      run: spec.run.toIR(inputValues),
      timeout: spec.timeout,
      retry: spec.retry,
    }) as AgentNodeIR;
    this.nodes.push(node);
    return makeNodeRef(id);
  }

  task<OutSchema extends Schema<any>>(id: string, spec: TaskStepSpec<OutSchema>): NodeRef<InferSchema<OutSchema>> {
    assertStableId(id, this.diagnostics);
    if (!task.isToken(spec.run)) this.diagnostics.push({ code: "T000", severity: "error", message: `Task node '${id}' must use run: task(async ctx => ...).` });
    const bundle = spec.run.toBundleIR();
    this.taskBundles[bundle.id] = bundle;
    const node = stripUndefined({
      id,
      kind: "task",
      inputs: inputsToIR(spec.input),
      outputSchema: toSchemaIR(spec.output),
      run: {
        kind: "task_run",
        bundleId: bundle.id,
        exportName: "default",
        digest: bundle.digest,
        runtime: "node",
        inline: spec.run.kind === "inline",
      },
      params: spec.params ?? spec.run.params,
      cwd: spec.cwd === undefined ? undefined : valueToExprIR(spec.cwd),
      env: envToIR(spec.env),
      execution: spec.execution,
      timeout: spec.timeout,
      retry: spec.retry,
    }) as TaskNodeIR;
    this.nodes.push(node);
    return makeNodeRef(id);
  }

  signal<OutSchema extends Schema<any>>(id: string, spec: SignalStepSpec<OutSchema>): NodeRef<InferSchema<OutSchema>> {
    assertStableId(id, this.diagnostics);
    if (!signal.isRun(spec.run)) this.diagnostics.push({ code: "S000", severity: "error", message: `Signal node '${id}' must use run: signal({...}).` });
    const node = stripUndefined({
      id,
      kind: "signal",
      inputs: inputsToIR(spec.input),
      outputSchema: toSchemaIR(spec.output),
      run: spec.run.toIR(makeInputRuntimeObject(spec.input)),
      timeout: spec.timeout,
      onTimeout: spec.onTimeout,
    }) as SignalNodeIR;
    this.nodes.push(node);
    return makeNodeRef(id);
  }

  guard(id: string, spec: GuardSpec): void {
    assertStableId(id, this.diagnostics);
    const node = stripUndefined({
      id,
      kind: "guard",
      when: valueToExprIR(spec.when),
      then: spec.then,
      otherwise: spec.otherwise,
      message: spec.message === undefined ? undefined : templateToIR(spec.message),
    }) as GuardNodeIR;
    this.nodes.push(node);
  }

  if<OutSchema extends Schema<any> | undefined>(id: string, spec: {
    when: unknown;
    then: (ctx: BranchContext) => OutputToken<any>;
    otherwise?: (ctx: BranchContext) => OutputToken<any>;
    output?: OutSchema;
  }): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown> {
    assertStableId(id, this.diagnostics);
    const thenScope = this.buildChildScope(spec.then);
    const otherwiseScope = spec.otherwise ? this.buildChildScope(spec.otherwise) : undefined;
    const node = stripUndefined({
      id,
      kind: "if",
      when: valueToExprIR(spec.when),
      then: thenScope,
      otherwise: otherwiseScope,
      outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
    }) as IfNodeIR;
    this.nodes.push(node);
    return makeNodeRef(id);
  }

  switch<OutSchema extends Schema<any> | undefined>(id: string, spec: {
    cases: Array<{ when: unknown; then: (ctx: BranchContext) => OutputToken<any> }>;
    otherwise?: (ctx: BranchContext) => OutputToken<any>;
    output?: OutSchema;
  }): NodeRef<OutSchema extends Schema<any> ? InferSchema<OutSchema> : unknown> {
    assertStableId(id, this.diagnostics);
    const cases = spec.cases.map(c => ({ when: valueToExprIR(c.when), then: this.buildChildScope(c.then) }));
    const node = stripUndefined({
      id,
      kind: "switch",
      cases,
      otherwise: spec.otherwise ? this.buildChildScope(spec.otherwise) : undefined,
      outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
    }) as SwitchNodeIR;
    this.nodes.push(node);
    return makeNodeRef(id);
  }

  parallel<Branches extends Record<string, (ctx: BranchContext) => OutputToken<any>>>(id: string, spec: {
    branches: Branches;
    join?: "all" | "race";
    maxConcurrency?: number;
    output?: Schema<any>;
  }): NodeRef<{ [K in keyof Branches]: unknown }> {
    assertStableId(id, this.diagnostics);
    const branches: Record<string, ScopeIR> = {};
    for (const [key, fn] of Object.entries(spec.branches)) branches[key] = this.buildChildScope(fn as any);
    const node = stripUndefined({
      id,
      kind: "parallel",
      branches,
      join: spec.join,
      maxConcurrency: spec.maxConcurrency,
      outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
    }) as ParallelNodeIR;
    this.nodes.push(node);
    return makeNodeRef(id);
  }

  fanout<OutSchema extends Schema<any> | undefined>(id: string, spec: {
    over: unknown;
    item?: Schema<any>;
    key?: Template | string;
    maxConcurrency?: number;
    join?: "all" | "race" | "quorum";
    quorum?: number;
    do: (ctx: BranchContext & { item: Expr<any>; itemIndex: Expr<number> }) => OutputToken<any>;
    output?: OutSchema;
  }): NodeRef<OutSchema extends Schema<any> ? Array<InferSchema<OutSchema>> : unknown[]> {
    assertStableId(id, this.diagnostics);
    const child = new StepBuilder(this.taskBundles, this.diagnostics);
    const result = spec.do({
      step: child,
      output: makeOutputToken,
      item: refExpr<any>(["fanout", id, "item"]) as Expr<any>,
      itemIndex: refExpr<number>(["fanout", id, "index"]) as Expr<number>,
    });
    const node = stripUndefined({
      id,
      kind: "fanout",
      over: valueToExprIR(spec.over),
      itemSchema: spec.item ? toSchemaIR(spec.item) : undefined,
      key: spec.key ? templateToIR(spec.key) : undefined,
      do: { nodes: child.nodes, outputs: result.ir },
      join: spec.join,
      maxConcurrency: spec.maxConcurrency,
      quorum: spec.quorum,
      outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
    }) as FanoutNodeIR;
    this.nodes.push(node);
    return makeNodeRef(id);
  }

  loop<OutSchema extends Schema<any>>(id: string, spec: {
    maxIterations: number;
    do: (ctx: BranchContext & { iter: Expr<number>; last: NodeRef<InferSchema<OutSchema>> }) => OutputToken<any>;
    until: (ctx: { last: NodeRef<InferSchema<OutSchema>> }) => unknown;
    output: OutSchema;
    onMaxIterations?: "fail" | "complete";
  }): NodeRef<InferSchema<OutSchema>> {
    assertStableId(id, this.diagnostics);
    const child = new StepBuilder(this.taskBundles, this.diagnostics);
    const lastRef = makeNodeRef<InferSchema<OutSchema>>(`${id}.__last`);
    const result = spec.do({ step: child, output: makeOutputToken, iter: refExpr<number>(["loop", id, "iter"]) as Expr<number>, last: lastRef });
    const until = spec.until({ last: lastRef });
    const node = stripUndefined({
      id,
      kind: "loop",
      maxIterations: spec.maxIterations,
      do: { nodes: child.nodes, outputs: result.ir },
      until: valueToExprIR(until),
      outputSchema: toSchemaIR(spec.output),
      onMaxIterations: spec.onMaxIterations,
    }) as LoopNodeIR;
    this.nodes.push(node);
    return makeNodeRef(id);
  }

  private buildChildScope(fn: (ctx: BranchContext) => OutputToken<any>): ScopeIR {
    const child = new StepBuilder(this.taskBundles, this.diagnostics);
    const result = fn({ step: child, output: makeOutputToken });
    if (!isOutputToken(result)) {
      this.diagnostics.push({ code: "B001", severity: "error", message: "Composite branch must return output({...})." });
      return { nodes: child.nodes };
    }
    return { nodes: child.nodes, outputs: result.ir };
  }
}

function assertStableId(id: string, diagnostics: DiagnosticIR[]): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
    diagnostics.push({
      code: "ID001",
      severity: "error",
      message: `Invalid node id '${id}'. Use /^[A-Za-z_][A-Za-z0-9_-]*$/.`,
      hint: "Node ids must be compile-time stable strings. Runtime Expr values are not allowed in node ids.",
    });
  }
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

