import type { Role, Stage, Variable, WorkflowSpec } from "../schema/workflow-spec.js";
import type { OutputContractName } from "../contracts/output-contracts.js";

export const EXECUTION_PLAN_VERSION = "acpx-workflow-orchestrator.execution-plan/v1";

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
  maxAgents: number;
  maxConcurrency: number;
  maxFanoutItems: number;
  maxFixRounds: number;
  stageTimeoutMinutes: number;
  maxOutputChars?: number;
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

export type ExecutionPlanStage = {
  id: string;
  kind: Stage["kind"];
  dependencies: string[];
  roleName?: string;
  contract?: ContractPlan;
  promptId?: string;
  session: SessionKeyStrategy;
  limits: Partial<ExecutionPlanLimits>;
  fanout?: {
    itemsSource: string;
    allowPartial: boolean;
    minCompletedRatio?: number;
    maxBlockedItems?: number;
    maxItems: number;
    maxConcurrency: number;
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
  fixLoop?: {
    maxRounds: number;
    validator: {
      roleName: string;
      promptId: string;
      contract: ContractPlan;
      session: SessionKeyStrategy;
    };
    fixer: {
      roleName: string;
      promptId: string;
      contract: ContractPlan;
      session: SessionKeyStrategy;
    };
    routingPolicy: Extract<Stage, { kind: "fixLoop" }>["routingPolicy"];
    onUnknown: "blocked";
    onExhausted: "blocked";
  };
};

export type FanoutPlan = {
  stageId: string;
  roleName: string;
  itemsSource: string;
  sessionKeyTemplate: string;
  maxItems: number;
  maxConcurrency: number;
  allowPartial: boolean;
};
