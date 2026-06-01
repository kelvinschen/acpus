import { contractNameForStage, getOutputContract, type OutputContractName } from "../contracts/output-contracts.js";
import type { Role, Stage, WorkflowSpec } from "../schema/workflow-spec.js";
import { EXECUTION_PLAN_VERSION, type ContractPlan, type ExecutionPlan, type ExecutionPlanLimits, type ExecutionPlanStage, type FanoutPlan, type PromptPlan } from "./execution-plan.js";

export type CompileExecutionPlanOptions = {
  stageIds?: string[];
  startStageId?: string;
};

export function compileExecutionPlan(spec: WorkflowSpec, options: CompileExecutionPlanOptions = {}): ExecutionPlan {
  const selected = options.stageIds ? new Set(options.stageIds) : undefined;
  const stageOrder = topologicalOrder(spec).filter((stageId) => !selected || selected.has(stageId));
  const limits = effectiveLimits(spec);
  const prompts: Record<string, PromptPlan> = {};
  const contracts: Record<string, ContractPlan> = {};
  const stages: ExecutionPlanStage[] = [];
  const fanout: FanoutPlan[] = [];

  for (const stageId of stageOrder) {
    const stage = spec.stages.find((candidate) => candidate.id === stageId);
    if (!stage) continue;
    const planStage = executionPlanStage(spec, stage, limits, prompts, contracts);
    stages.push(planStage);
    if (planStage.fanout && planStage.roleName) {
      fanout.push({
        stageId: stage.id,
        roleName: planStage.roleName,
        itemsSource: planStage.fanout.itemsSource,
        sessionKeyTemplate: `role:${planStage.roleName}:fanout:${stage.id}:item:{itemId}`,
        maxItems: planStage.fanout.maxItems,
        maxConcurrency: planStage.fanout.maxConcurrency,
        allowPartial: planStage.fanout.allowPartial
      });
    }
  }

  return {
    version: EXECUTION_PLAN_VERSION,
    workflowName: spec.name,
    root: options.startStageId ?? spec.root,
    stages,
    roles: Object.fromEntries(Object.entries(spec.roles).map(([name, role]) => [name, { name, ...role }])),
    limits,
    prompts,
    contracts,
    repairPolicy: {
      maxRepairTurns: 1,
      repairableReasons: ["OUTPUT_PARSE_FAILED", "OUTPUT_SCHEMA_FAILED"]
    },
    fanout
  };
}

export function renderStagePrompt(spec: WorkflowSpec, stage: Stage): string {
  const roleName = stageRoleName(stage);
  const role = roleName ? spec.roles[roleName] : undefined;
  const contractName = contractNameForStage(stage, role);
  const contractOptions = contractOptionsForStage(spec, stage, contractName);
  const footer = stageSafetyFooter(stage, role, contractName, contractOptions);
  return `${stage.prompt ?? ""}${footer}`;
}

export function renderPromptMap(spec: WorkflowSpec): Record<string, string> {
  const plan = compileExecutionPlan(spec);
  return Object.fromEntries(Object.entries(plan.prompts).map(([id, prompt]) => [id, `${prompt.template}${prompt.footer}`]));
}

export function topologicalOrder(spec: WorkflowSpec): string[] {
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

export function stageRoleName(stage: Stage): string | undefined {
  if (stage.kind === "agentTask" || stage.kind === "fanout" || stage.kind === "summarize") return stage.role;
  if (stage.kind === "discover" || stage.kind === "reduce" || stage.kind === "decisionGate") return stage.role;
  return undefined;
}

function executionPlanStage(
  spec: WorkflowSpec,
  stage: Stage,
  limits: ExecutionPlanLimits,
  prompts: Record<string, PromptPlan>,
  contracts: Record<string, ContractPlan>
): ExecutionPlanStage {
  const roleName = stageRoleName(stage);
  const role = roleName ? spec.roles[roleName] : undefined;
  const contractName = contractNameForStage(stage, role);
  const contract = contractPlanForStage(spec, stage, contractName);
  contracts[stage.id] = contract;
  const promptId = promptIdForStage(stage);
  if (promptId && "prompt" in stage && typeof stage.prompt === "string") {
    prompts[promptId] = promptPlan(spec, stage, promptId, stage.prompt, stage.variables ?? [], roleName, contract);
  }

  const base: ExecutionPlanStage = {
    id: stage.id,
    kind: stage.kind,
    dependencies: stage.dependsOn ?? [],
    roleName,
    contract,
    promptId,
    session: roleName ? { kind: "linear", key: `role:${roleName}` } : { kind: "linear", key: `stage:${stage.id}` },
    limits: stage.limits ?? {}
  };

  if (stage.kind === "discover") {
    return {
      ...base,
      discover: {
        method: stage.method,
        args: stage.args,
        outputKey: stage.output
      }
    };
  }
  if (stage.kind === "fanout") {
    const maxConcurrency = Math.max(1, Math.min(limits.maxConcurrency, stage.limits?.maxConcurrency ?? limits.maxConcurrency));
    return {
      ...base,
      session: { kind: "fanoutItem", template: `role:${stage.role}:fanout:${stage.id}:item:{itemId}` },
      fanout: {
        itemsSource: stage.items.source,
        allowPartial: stage.fanoutPolicy?.allowPartial ?? false,
        minCompletedRatio: stage.fanoutPolicy?.minCompletedRatio,
        maxBlockedItems: stage.fanoutPolicy?.maxBlockedItems,
        maxItems: stage.limits?.maxFanoutItems ?? limits.maxFanoutItems,
        maxConcurrency
      }
    };
  }
  if (stage.kind === "reduce") {
    return {
      ...base,
      reduce: {
        mode: stage.mode,
        from: stage.from,
        operation: stage.operation
      }
    };
  }
  if (stage.kind === "decisionGate") {
    return {
      ...base,
      decision: {
        mode: stage.mode,
        rules: stage.rules,
        defaultRoute: stage.default,
        routes: stage.routes ?? [...stage.rules.map((rule) => rule.to), stage.default]
      }
    };
  }
  if (stage.kind === "fixLoop") {
    const validatorRole = spec.roles[stage.validator.role];
    const fixerRole = spec.roles[stage.fixer.role];
    const validatorContract = contractPlan("validation");
    const fixerContract = contractPlan("implementation");
    prompts[`${stage.id}__validate`] = promptPlan(spec, stage, `${stage.id}__validate`, stage.validator.prompt, stage.validator.variables ?? [], stage.validator.role, validatorContract, validatorRole);
    prompts[`${stage.id}__fix`] = promptPlan(spec, stage, `${stage.id}__fix`, stage.fixer.prompt, stage.fixer.variables ?? [], stage.fixer.role, fixerContract, fixerRole);
    contracts[`${stage.id}__validate`] = validatorContract;
    contracts[`${stage.id}__fix`] = fixerContract;
    return {
      ...base,
      contract: validatorContract,
      promptId: undefined,
      fixLoop: {
        maxRounds: stage.maxRounds,
        validator: {
          roleName: stage.validator.role,
          promptId: `${stage.id}__validate`,
          contract: validatorContract,
          session: { kind: "linear", key: `role:${stage.validator.role}` }
        },
        fixer: {
          roleName: stage.fixer.role,
          promptId: `${stage.id}__fix`,
          contract: fixerContract,
          session: { kind: "linear", key: `role:${stage.fixer.role}` }
        },
        routingPolicy: stage.routingPolicy,
        onUnknown: stage.onUnknown,
        onExhausted: stage.onExhausted
      }
    };
  }
  return base;
}

function promptPlan(
  spec: WorkflowSpec,
  stage: Stage,
  promptId: string,
  template: string,
  variables: PromptPlan["variables"],
  roleName: string | undefined,
  contract: ContractPlan,
  roleOverride?: Role
): PromptPlan {
  const role = roleOverride ?? (roleName ? spec.roles[roleName] : undefined);
  return {
    id: promptId,
    stageId: stage.id,
    template,
    variables,
    footer: stageSafetyFooter(stage, role, contract.name, contract.options),
    roleName,
    contractName: contract.name,
    contractOptions: contract.options
  };
}

function promptIdForStage(stage: Stage): string | undefined {
  if ("prompt" in stage && typeof stage.prompt === "string") return stage.id;
  return undefined;
}

function effectiveLimits(spec: WorkflowSpec): ExecutionPlanLimits {
  return {
    maxAgents: spec.limits.maxAgents ?? 1,
    maxConcurrency: spec.limits.maxConcurrency ?? 1,
    maxFanoutItems: spec.limits.maxFanoutItems ?? 1,
    maxFixRounds: spec.limits.maxFixRounds ?? 0,
    stageTimeoutMinutes: spec.limits.stageTimeoutMinutes ?? 60,
    maxOutputChars: spec.limits.maxOutputChars
  };
}

function contractPlanForStage(spec: WorkflowSpec, stage: Stage, name: OutputContractName): ContractPlan {
  return contractPlan(name, contractOptionsForStage(spec, stage, name));
}

function contractPlan(name: OutputContractName, options?: ContractPlan["options"]): ContractPlan {
  return Object.keys(options ?? {}).length > 0 ? { name, options } : { name };
}

function contractOptionsForStage(spec: WorkflowSpec, stage: Stage, name: OutputContractName): ContractPlan["options"] | undefined {
  if (name !== "discover" || stage.kind !== "discover") return undefined;
  return {
    outputKey: stage.output,
    maxItems: stage.limits?.maxFanoutItems ?? spec.limits.maxFanoutItems
  };
}

function stageSafetyFooter(stage: Stage, role: Role | undefined, contractName: OutputContractName, contractOptions?: ContractPlan["options"]): string {
  const mode = role?.mode ?? "readOnly";
  const contract = getOutputContract(contractName, contractOptions);
  const lines = [
    "",
    "Workflow stage contract:",
    `- Stage id: ${stage.id}`,
    `- Role mode: ${mode}`,
    "- Keep work scoped to the provided cwd and workflow task.",
    "- Do not leak secrets or sensitive data in output.",
    "- Preserve unrelated user changes.",
    contract.footerText()
  ];
  if (mode === "readOnly" || mode === "denyAll") {
    lines.push("- Do not edit production files in this stage.");
  }
  if (mode === "edit") {
    lines.push("- Only edit files required by this stage. Avoid unrelated refactors.");
  }
  return lines.join("\n");
}
