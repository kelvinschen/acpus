import type { Actor, ConditionNode, Stage, Variable } from "../schema/workflow-spec.js";
import type { CompiledSchema } from "../contracts/schema-dsl.js";

export const EXECUTION_PLAN_VERSION = "acpus.execution-plan/v1";

export type ExecutionPlan = {
  version: typeof EXECUTION_PLAN_VERSION;
  workflowName: string;
  root: string;
  stages: ExecutionPlanStage[];
  limits: ExecutionPlanLimits;
  prompts: Record<string, PromptPlan>;
  fanout: FanoutPlan[];
};

export type ExecutionPlanLimits = {
  stageTimeoutMinutes: number;
};

export type ExecutionPlanStageLimits = {
  maxConcurrency?: number;
  maxFanoutItems?: number;
  stageTimeoutMinutes?: number;
};

export type PromptPlan = {
  id: string;
  stageId: string;
  template: string;
  variables: Variable[];
  footer: string;
  actor?: Actor;
  outputSchema?: CompiledSchema;
  implicitOutputFields?: string[];
};

export type SessionKeyStrategy =
  | { kind: "linear"; key: string }
  | { kind: "fanoutItem"; template: string };

export type AgentPlan = {
  actor: Actor;
  promptId: string;
  outputSchema?: CompiledSchema;
  implicitOutputFields?: string[];
};

export type ProgramCommandPlan = {
  operation: "command";
  command: string;
  args: string[];
  cwd?: string;
  timeoutSeconds: number;
  allowMutation: boolean;
};

export type FanoutLanePlan = {
  id: string;
  actor: Actor;
  promptId: string;
  outputSchema?: CompiledSchema;
  implicitOutputFields?: string[];
  sessionKeyTemplate: string;
  when?: ConditionNode;
};

export type FanoutFaninPlan =
  | ({ mode: "agent" } & AgentPlan & { sessionKey: string })
  | { mode: "program"; operation: "mergeArrays" };

export type ExecutionPlanStage = {
  id: string;
  kind: Stage["kind"];
  dependencies: string[];
  session: SessionKeyStrategy;
  limits: ExecutionPlanStageLimits;
  agent?: AgentPlan;
  program?: ProgramCommandPlan;
  route?: {
    mode: "agent" | "program";
    rules: Array<{ when: ConditionNode; to: string }>;
    routes: string[];
  };
  gate?: {
    mode: "agent" | "program";
    condition?: ConditionNode;
  };
  fanout?: {
    itemsSource: string;
    allowPartial: boolean;
    minCompletedRatio?: number;
    maxBlockedItems?: number;
    maxItems: number;
    maxConcurrency: number;
    lanes: FanoutLanePlan[];
    fanin: FanoutFaninPlan;
  };
  loop?: {
    maxRounds: number;
    body: {
      root: string;
      output: string;
      stages: ExecutionPlanStage[];
    };
    continueWhen: ConditionNode;
    onExhausted: "blocked";
  };
};

export type FanoutPlan = {
  stageId: string;
  itemsSource: string;
  maxItems: number;
  maxConcurrency: number;
  allowPartial: boolean;
  minCompletedRatio?: number;
  maxBlockedItems?: number;
  lanes: FanoutLanePlan[];
  fanin: FanoutFaninPlan;
};
