import type { Role, Stage, Variable, WorkflowSpec } from "../schema/workflow-spec.js";
import type { OutputContractName } from "../contracts/output-contracts.js";

export const EXECUTION_PLAN_VERSION = "acpus.execution-plan/v1";

export type ExecutionPlan = {
  version: typeof EXECUTION_PLAN_VERSION;
  workflowName: string;
  root: string;
  stages: ExecutionPlanStage[];
  roles: Record<string, ExecutionPlanRole>;
  limits: ExecutionPlanLimits;
  prompts: Record<string, PromptPlan>;
  contracts: Record<string, ContractPlan>;
  repairPolicy: RepairPolicyPlan;
  fanout: FanoutPlan[];
};

export type ExecutionPlanRole = Role & {
  name: string;
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
  roleName?: string;
  contractName: OutputContractName;
  contractOptions?: ContractPlan["options"];
};

export type ContractPlan = {
  name: OutputContractName;
  options?: {
    outputKey?: string;
    maxItems?: number;
  };
};

export type RepairPolicyPlan = {
  maxRepairTurns: 1;
  repairableReasons: ["OUTPUT_PARSE_FAILED", "OUTPUT_SCHEMA_FAILED"];
};

export type SessionKeyStrategy =
  | { kind: "linear"; key: string }
  | { kind: "fanoutItem"; template: string };

export type FanoutLanePlan = {
  id: string;
  roleName: string;
  promptId: string;
  contract: ContractPlan;
  sessionKeyTemplate: string;
  when?: Extract<Stage, { kind: "fanout" }>["laneGroups"][number]["lanes"][number]["when"];
  default?: boolean;
};

export type FanoutLaneGroupPlan = {
  id: string;
  mode: "all" | "oneOf";
  lanes: FanoutLanePlan[];
};

export type ExecutionPlanStage = {
  id: string;
  kind: Stage["kind"];
  dependencies: string[];
  roleName?: string;
  contract?: ContractPlan;
  promptId?: string;
  session: SessionKeyStrategy;
  limits: ExecutionPlanStageLimits;
  fanout?: {
    itemsSource: string;
    allowPartial: boolean;
    minCompletedRatio?: number;
    maxBlockedItems?: number;
    maxItems: number;
    maxConcurrency: number;
    laneGroups: FanoutLaneGroupPlan[];
  };
  reduce?: {
    mode: "agent" | "program";
    from: string;
    operation?: string;
  };
  discover?: {
    method: "gitChangedFiles" | "glob" | "agent";
    args?: Record<string, unknown>;
    outputKey: string;
  };
  decision?: {
    mode: "agent" | "program";
    rules: Extract<Stage, { kind: "decisionGate" }>["rules"];
    defaultRoute: string;
    routes: string[];
  };
  gate?: {
    mode: "agent" | "program";
    condition?: Extract<Stage, { kind: "gate" }>["condition"];
  };
  loop?: {
    maxRounds: number;
    body: {
      root: string;
      output: string;
      stages: ExecutionPlanStage[];
    };
    continueWhen: Extract<Stage, { kind: "loop" }>["continueWhen"];
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
  laneGroups: FanoutLaneGroupPlan[];
};
