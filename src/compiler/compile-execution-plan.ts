import { compileSchemaDsl, outputSchemaFooter, type CompiledSchema } from "../contracts/schema-dsl.js";
import { resolveStageLimits, resolveWorkflowLimits } from "../schema/limit-resolution.js";
import type { Actor, Stage, WorkflowSpec } from "../schema/workflow-spec.js";
import { EXECUTION_PLAN_VERSION, type AgentPlan, type ExecutionPlan, type ExecutionPlanLimits, type ExecutionPlanStage, type FanoutFaninPlan, type FanoutPlan, type PromptPlan } from "./execution-plan.js";

export type CompileExecutionPlanOptions = {
  stageIds?: string[];
  startStageId?: string;
  input?: Record<string, unknown>;
};

export function compileExecutionPlan(spec: WorkflowSpec, options: CompileExecutionPlanOptions = {}): ExecutionPlan {
  const selected = options.stageIds ? new Set(options.stageIds) : undefined;
  const stageOrder = topologicalOrder(spec).filter((stageId) => !selected || selected.has(stageId));
  const input = {
    ...(spec.input?.default ?? {}),
    ...(options.input ?? {})
  };
  const limits = effectiveLimits(spec, input);
  const prompts: Record<string, PromptPlan> = {};
  const stages: ExecutionPlanStage[] = [];
  const fanout: FanoutPlan[] = [];

  for (const stageId of stageOrder) {
    const stage = spec.stages.find((candidate) => candidate.id === stageId);
    if (!stage) continue;
    const planStage = executionPlanStage(spec, stage, limits, prompts, input);
    stages.push(planStage);
    if (planStage.fanout) {
      fanout.push({
        stageId: stage.id,
        itemsSource: planStage.fanout.itemsSource,
        maxItems: planStage.fanout.maxItems,
        maxConcurrency: planStage.fanout.maxConcurrency,
        allowPartial: planStage.fanout.allowPartial,
        minCompletedRatio: planStage.fanout.minCompletedRatio,
        maxBlockedItems: planStage.fanout.maxBlockedItems,
        lanes: planStage.fanout.lanes,
        fanin: planStage.fanout.fanin
      });
    }
  }

  return {
    version: EXECUTION_PLAN_VERSION,
    workflowName: spec.name,
    root: options.startStageId ?? spec.root,
    stages,
    limits,
    prompts,
    fanout
  };
}

export function renderStagePrompt(_spec: WorkflowSpec, stage: Stage): string {
  if (!("prompt" in stage) || typeof stage.prompt !== "string") return "";
  const outputSchema = outputSchemaFor(stage);
  return `${stage.prompt}${stageSafetyFooter(outputSchema, implicitOutputFields(stage))}`;
}

export function renderPromptMap(spec: WorkflowSpec): Record<string, string> {
  const plan = compileExecutionPlan(spec);
  return Object.fromEntries(Object.entries(plan.prompts).map(([id, prompt]) => [id, `${prompt.template}${prompt.footer}`]));
}

export function topologicalOrder(spec: Pick<WorkflowSpec, "root" | "stages">): string[] {
  const byId = new Map(spec.stages.map((stage) => [stage.id, stage] as const));
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const stage = byId.get(id);
    if (!stage) return;
    for (const dep of stage.dependsOn ?? []) visit(dep);
    visited.add(id);
    order.push(id);
  };
  visit(spec.root);
  for (const stage of spec.stages) visit(stage.id);
  return order;
}

export function stageActor(stage: Stage): Actor | undefined {
  if (stage.kind === "task" && stage.mode === "agent") return stage.actor;
  if (stage.kind === "route" && stage.mode === "agent") return stage.actor;
  if (stage.kind === "gate" && stage.mode === "agent") return stage.actor;
  return undefined;
}

export function stageActorLabel(stage: Stage): string | undefined {
  return actorLabel(stageActor(stage), stage.id);
}

function executionPlanStage(
  spec: WorkflowSpec,
  stage: Stage,
  limits: ExecutionPlanLimits,
  prompts: Record<string, PromptPlan>,
  input: Record<string, unknown>
): ExecutionPlanStage {
  const stageLimits = resolveStageLimits(stage.limits, input);
  const base: ExecutionPlanStage = {
    id: stage.id,
    kind: stage.kind,
    dependencies: stage.dependsOn ?? [],
    session: { kind: "linear", key: `stage:${stage.id}` },
    limits: stageLimits
  };

  if (stage.kind === "task") {
    if (stage.mode === "agent") {
      const agent = agentPlan(stage.id, stage.actor, stage.prompt, stage.variables ?? [], outputSchemaFor(stage), [], prompts);
      return { ...base, session: { kind: "linear", key: `agent:${actorLabel(stage.actor, stage.id)}` }, agent };
    }
    return {
      ...base,
      program: {
        operation: "command",
        command: stage.command,
        args: stage.args,
        cwd: stage.cwd,
        timeoutSeconds: stage.timeoutSeconds,
        allowMutation: stage.allowMutation
      }
    };
  }

  if (stage.kind === "route") {
    if (stage.mode === "agent" && stage.actor && stage.prompt) {
      const agent = agentPlan(stage.id, stage.actor, stage.prompt, stage.variables ?? [], undefined, [`route:${stage.routes.join("|")}`], prompts);
      return {
        ...base,
        session: { kind: "linear", key: `route:${stage.id}` },
        agent,
        route: { mode: "agent", rules: stage.rules, routes: stage.routes }
      };
    }
    return {
      ...base,
      route: { mode: "program", rules: stage.rules, routes: stage.routes }
    };
  }

  if (stage.kind === "gate") {
    if (stage.mode === "agent" && stage.actor && stage.prompt) {
      const agent = agentPlan(stage.id, stage.actor, stage.prompt, stage.variables ?? [], outputSchemaFor(stage), ["verdict"], prompts);
      return {
        ...base,
        session: { kind: "linear", key: `gate:${stage.id}` },
        agent,
        gate: { mode: "agent", condition: stage.condition }
      };
    }
    return { ...base, gate: { mode: "program", condition: stage.condition } };
  }

  if (stage.kind === "fanout") {
    const maxConcurrency = stageLimits.maxConcurrency ?? 1;
    const lanes = stage.lanes.map((lane) => {
      const promptId = `${stage.id}__${lane.id}`;
      const schema = lane.output?.schema ? compileSchemaDsl(lane.output.schema) : undefined;
      prompts[promptId] = promptPlan(promptId, stage.id, lane.prompt ?? stage.prompt ?? "", stage.variables ?? [], lane.actor, schema, []);
      return {
        id: lane.id,
        actor: lane.actor,
        promptId,
        outputSchema: schema,
        implicitOutputFields: [],
        sessionKeyTemplate: `fanout:${stage.id}:item:{itemId}:lane:${lane.id}:agent:${actorLabel(lane.actor, lane.id)}`,
        when: lane.when
      };
    });
    const fanin = faninPlan(stage.id, stage.fanin, stage.variables ?? [], prompts);
    return {
      ...base,
      session: { kind: "fanoutItem", template: `fanout:${stage.id}:item:{itemId}:lane:{laneId}` },
      fanout: {
        itemsSource: stage.items.source,
        allowPartial: stage.fanoutPolicy?.allowPartial ?? false,
        minCompletedRatio: stage.fanoutPolicy?.minCompletedRatio,
        maxBlockedItems: stage.fanoutPolicy?.maxBlockedItems,
        maxItems: stageLimits.maxFanoutItems ?? 1,
        maxConcurrency,
        lanes,
        fanin
      }
    };
  }

  if (stage.kind === "loop") {
    const bodyPlan = compileLoopBodyExecutionPlan(spec, stage, limits, prompts, input);
    return {
      ...base,
      session: { kind: "linear", key: `loop:${stage.id}` },
      loop: {
        maxRounds: stage.maxRounds,
        body: {
          root: stage.body.root,
          output: stage.body.output,
          stages: bodyPlan
        },
        continueWhen: stage.continueWhen,
        onExhausted: stage.onExhausted
      }
    };
  }

  return base;
}

function compileLoopBodyExecutionPlan(
  spec: WorkflowSpec,
  loop: Extract<Stage, { kind: "loop" }>,
  limits: ExecutionPlanLimits,
  prompts: Record<string, PromptPlan>,
  input: Record<string, unknown>
): ExecutionPlanStage[] {
  const bodySpec = {
    ...spec,
    root: loop.body.root,
    stages: loop.body.stages as Stage[]
  };
  const stages: ExecutionPlanStage[] = [];
  for (const stageId of topologicalOrder(bodySpec)) {
    const bodyStage = bodySpec.stages.find((candidate) => candidate.id === stageId);
    if (!bodyStage) continue;
    const localPrompts: Record<string, PromptPlan> = {};
    const planStage = executionPlanStage(spec, bodyStage, limits, localPrompts, input);
    for (const [id, prompt] of Object.entries(localPrompts)) {
      prompts[`${loop.id}__${id}`] = { ...prompt, id: `${loop.id}__${prompt.id}`, stageId: `${loop.id}.${prompt.stageId}` };
    }
    stages.push(prefixLoopBodyPlan(loop.id, planStage));
  }
  return stages;
}

function prefixLoopBodyPlan(loopId: string, stage: ExecutionPlanStage): ExecutionPlanStage {
  const prefixPrompt = (promptId: string | undefined) => promptId ? `${loopId}__${promptId}` : undefined;
  const next: ExecutionPlanStage = {
    ...stage,
    agent: stage.agent ? { ...stage.agent, promptId: prefixPrompt(stage.agent.promptId) ?? stage.agent.promptId } : undefined,
    dependencies: stage.dependencies,
    session: stage.session.kind === "linear" ? { kind: "linear", key: `loop:${loopId}:${stage.session.key}` } : stage.session
  };
  if (stage.fanout) {
    next.fanout = {
      ...stage.fanout,
      lanes: stage.fanout.lanes.map((lane) => ({
        ...lane,
        promptId: `${loopId}__${lane.promptId}`,
        sessionKeyTemplate: `loop:${loopId}:${lane.sessionKeyTemplate}`
      })),
      fanin: prefixFanin(loopId, stage.id, stage.fanout.fanin)
    };
  }
  return next;
}

function prefixFanin(loopId: string, stageId: string, fanin: FanoutFaninPlan): FanoutFaninPlan {
  if (fanin.mode !== "agent") return fanin;
  return {
    ...fanin,
    promptId: `${loopId}__${fanin.promptId}`,
    sessionKey: `loop:${loopId}:round:{round}:fanin:${stageId}`
  };
}

function faninPlan(stageId: string, fanin: Extract<Stage, { kind: "fanout" }>["fanin"], variables: PromptPlan["variables"], prompts: Record<string, PromptPlan>): FanoutFaninPlan {
  if (fanin.mode === "program") return { mode: "program", operation: "mergeArrays" };
  const promptId = `${stageId}__fanin`;
  const schema = fanin.output?.schema ? compileSchemaDsl(fanin.output.schema) : undefined;
  const faninVariables = [
    ...variables.filter((variable) => variable.name !== "results" && !isItemScopedVariable(variable)),
    { name: "results", source: "results", transform: [{ fn: "json" as const }] }
  ];
  prompts[promptId] = promptPlan(promptId, stageId, fanin.prompt, faninVariables, fanin.actor, schema, []);
  return {
    mode: "agent",
    actor: fanin.actor,
    promptId,
    outputSchema: schema,
    implicitOutputFields: [],
    sessionKey: `fanin:${stageId}`
  };
}

function isItemScopedVariable(variable: PromptPlan["variables"][number]): boolean {
  return variable.source === "item" || variable.source.startsWith("item.");
}

function agentPlan(
  stageId: string,
  actor: Actor,
  prompt: string,
  variables: PromptPlan["variables"],
  outputSchema: CompiledSchema | undefined,
  implicit: string[],
  prompts: Record<string, PromptPlan>
): AgentPlan {
  prompts[stageId] = promptPlan(stageId, stageId, prompt, variables, actor, outputSchema, implicit);
  return {
    actor,
    promptId: stageId,
    outputSchema,
    implicitOutputFields: implicit
  };
}

function promptPlan(
  promptId: string,
  stageId: string,
  template: string,
  variables: PromptPlan["variables"],
  actor: Actor,
  outputSchema: CompiledSchema | undefined,
  implicit: string[]
): PromptPlan {
  return {
    id: promptId,
    stageId,
    template,
    variables,
    footer: stageSafetyFooter(outputSchema, implicit),
    actor,
    outputSchema,
    implicitOutputFields: implicit
  };
}

function effectiveLimits(spec: WorkflowSpec, input: Record<string, unknown>): ExecutionPlanLimits {
  return resolveWorkflowLimits(spec, input);
}

function outputSchemaFor(stage: Stage): CompiledSchema | undefined {
  if ((stage.kind === "task" && stage.mode === "agent") || (stage.kind === "gate" && stage.mode === "agent")) {
    return stage.output?.schema ? compileSchemaDsl(stage.output.schema) : undefined;
  }
  return undefined;
}

function implicitOutputFields(stage: Stage): string[] {
  if (stage.kind === "gate" && stage.mode === "agent") return ["verdict"];
  if (stage.kind === "route" && stage.mode === "agent") return [`route:${stage.routes.join("|")}`];
  return [];
}

function stageSafetyFooter(outputSchema: CompiledSchema | undefined, implicit: string[]): string {
  return outputSchemaFooter(outputSchema, implicit);
}

function actorLabel(actor: Actor | undefined, fallback: string): string {
  return actor?.label ?? actor?.agent ?? fallback;
}
