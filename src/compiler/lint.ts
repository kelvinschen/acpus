import { issue, type OrchestratorIssue } from "../errors.js";
import { contractNameForStage } from "../contracts/output-contracts.js";
import { validateInputDefaults } from "../schema/input-validation.js";
import type { Stage, WorkflowSpec } from "../schema/workflow-spec.js";
import { findVariableIssues } from "../variables/interpolate.js";
import { parseSourcePath } from "../variables/paths.js";

export function lintWorkflowSpec(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const stages = new Map<string, Stage>();

  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stages.has(stage.id)) {
      issues.push(issue({
        code: "GRAPH_DUPLICATE_STAGE_ID",
        severity: "error",
        path: `/stages/${index}/id`,
        message: `Duplicate stage id: ${stage.id}`,
        suggestions: ["Give every stage a unique id."]
      }));
    }
    stages.set(stage.id, stage);
  }

  issues.push(...lintGraph(spec, stages));
  issues.push(...lintRoles(spec, stages));
  issues.push(...lintVariables(spec, stages));
  issues.push(...lintLimits(spec));
  issues.push(...lintDecisionGates(spec, stages));
  issues.push(...lintGates(spec));
  issues.push(...lintDiscover(spec));
  issues.push(...lintFanout(spec, stages));
  issues.push(...validateInputDefaults(spec));
  return issues;
}

function lintGraph(spec: WorkflowSpec, stages: Map<string, Stage>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const rootStage = stages.get(spec.root);
  if (!rootStage) {
    issues.push(issue({
      code: "GRAPH_ROOT_UNKNOWN",
      severity: "error",
      path: "/root",
      message: `Workflow root ${spec.root} does not match any stage id.`,
      suggestions: ["Set /root to the id of the single stage with no dependsOn."]
    }));
  } else if ((rootStage.dependsOn ?? []).length > 0) {
    issues.push(issue({
      code: "GRAPH_ROOT_HAS_DEPENDENCIES",
      severity: "error",
      path: "/root",
      message: `Workflow root ${spec.root} must not have dependsOn entries.`,
      suggestions: ["Choose the dependency-free root stage, or remove root dependsOn."]
    }));
  }
  const roots = spec.stages.filter((stage) => (stage.dependsOn ?? []).length === 0);
  if (roots.length !== 1) {
    issues.push(issue({
      code: "GRAPH_ROOT_COUNT_INVALID",
      severity: "error",
      path: "/stages",
      message: `Workflow must have exactly one root stage; found ${roots.length}.`,
      suggestions: ["Add dependsOn to all non-root stages so only one stage has no dependencies."]
    }));
  } else if (roots[0].id !== spec.root) {
    issues.push(issue({
      code: "GRAPH_ROOT_MISMATCH",
      severity: "error",
      path: "/root",
      message: `Workflow root is ${spec.root}, but the dependency-free root stage is ${roots[0].id}.`,
      suggestions: [`Set /root to "${roots[0].id}" or adjust dependsOn so ${spec.root} is the only root.`]
    }));
  }

  const gate = spec.stages.filter((stage) => stage.kind === "gate");
  if (gate.length !== 1) {
    issues.push(issue({
      code: "GRAPH_GATE_COUNT_INVALID",
      severity: "error",
      path: "/stages",
      message: `Workflow must have exactly one gate stage; found ${gate.length}.`,
      suggestions: ["Add exactly one final gate stage as the terminal completion signal."]
    }));
  }
  if (gate.length === 1) {
    const gateDependents = spec.stages.filter((stage) => (stage.dependsOn ?? []).includes(gate[0].id));
    if (gateDependents.length > 0) {
      issues.push(issue({
        code: "GRAPH_GATE_NOT_TERMINAL",
        severity: "error",
        path: "/stages",
        message: `Gate stage ${gate[0].id} must be terminal, but ${gateDependents.length} stage(s) depend on it.`,
        suggestions: ["Move all downstream work before the terminal gate."]
      }));
    }
  }
  const summarize = spec.stages.filter((stage) => stage.kind === "summarize");
  for (const summarizeStage of summarize) {
    issues.push(issue({
      code: "GRAPH_SUMMARIZE_DEPRECATED",
      severity: "error",
      path: "/stages",
      message: `Summarize stage ${summarizeStage.id} is no longer a supported terminal stage.`,
      suggestions: ["Replace summarize with a terminal gate stage. Use mode program for mechanical completion checks or mode agent for semantic gating."]
    }));
  }

  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    for (const dep of stage.dependsOn ?? []) {
      if (!stages.has(dep)) {
        issues.push(issue({
          code: "GRAPH_UNKNOWN_DEPENDENCY",
          severity: "error",
          path: `/stages/${index}/dependsOn`,
          message: `Stage ${stage.id} depends on unknown stage ${dep}.`,
          suggestions: [`Add a stage named ${dep}, or remove it from dependsOn.`]
        }));
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      issues.push(issue({
        code: "GRAPH_CYCLE",
        severity: "error",
        path: "/stages",
        message: `Cycle detected: ${[...path, id].join(" -> ")}`,
        suggestions: ["Remove the cycle. Use fixLoop for bounded loops."]
      }));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const stage = stages.get(id);
    for (const dep of stage?.dependsOn ?? []) visit(dep, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const stage of spec.stages) visit(stage.id, []);

  const dependents = new Map<string, string[]>();
  for (const stage of spec.stages) {
    for (const dep of stage.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(stage.id);
      dependents.set(dep, list);
    }
  }
  for (const stage of spec.stages) {
    const next = dependents.get(stage.id) ?? [];
    if (next.length > 1 && stage.kind !== "decisionGate") {
      issues.push(issue({
        code: "GRAPH_BRANCH_REQUIRES_DECISION_GATE",
        severity: "error",
        path: "/stages",
        message: `Stage ${stage.id} has multiple dependents (${next.join(", ")}), but only decisionGate may branch in the execution plan.`,
        suggestions: ["Insert an explicit decisionGate before branching, or restructure the workflow as a linear sequence/reduce."]
      }));
    }
    if (next.length === 0 && stage.kind !== "gate") {
      issues.push(issue({
        code: "GRAPH_NON_GATE_TERMINAL",
        severity: "error",
        path: "/stages",
        message: `Stage ${stage.id} is terminal, but only gate may be the terminal workflow stage.`,
        suggestions: ["Add a terminal gate depending on this stage, or move downstream work before the existing gate."]
      }));
    }
  }
  return issues;
}

function lintRoles(spec: WorkflowSpec, stages: Map<string, Stage>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const roleNames = new Set(Object.keys(spec.roles));
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    for (const role of stageRoles(stage)) {
      if (!roleNames.has(role)) {
        issues.push(issue({
          code: "ROLE_UNKNOWN",
          severity: "error",
          path: `/stages/${index}/role`,
          message: `Stage ${stage.id} references unknown role ${role}.`,
          suggestions: [`Define /roles/${role}, or use an existing role.`]
        }));
      }
    }
    if (stage.kind === "gate" && stage.mode === "agent") {
      if (!stage.role) {
        issues.push(issue({
          code: "ROLE_GATE_REQUIRED",
          severity: "error",
          path: `/stages/${index}/role`,
          message: `Agent gate stage ${stage.id} requires a role.`,
          suggestions: ["Add a readOnly validation, review, coordination, or summarization role."]
        }));
      }
      if (!stage.prompt) {
        issues.push(issue({
          code: "GATE_AGENT_PROMPT_REQUIRED",
          severity: "error",
          path: `/stages/${index}/prompt`,
          message: `Agent gate stage ${stage.id} requires a prompt.`,
          suggestions: ["Add a prompt that instructs the agent to return a gate verdict."]
        }));
      }
      if (stage.role && spec.roles[stage.role]?.mode === "edit") {
        issues.push(issue({
          code: "ROLE_MODE_CONFLICT",
          severity: "error",
          path: `/stages/${index}/role`,
          message: `Agent gate stage ${stage.id} must not use an edit role.`,
          suggestions: ["Use a readOnly or denyAll role for terminal gate decisions."]
        }));
      }
    }
    if (stage.kind === "fixLoop") {
      const validator = spec.roles[stage.validator.role];
      const fixer = spec.roles[stage.fixer.role];
      if (validator?.mode === "edit") {
        issues.push(issue({
          code: "ROLE_MODE_CONFLICT",
          severity: "error",
          path: `/stages/${index}/validator/role`,
          message: "fixLoop validator role must not be edit mode.",
          suggestions: ["Use a readOnly validation or review role for validator."]
        }));
      }
      if (fixer && fixer.mode !== "edit") {
        issues.push(issue({
          code: "ROLE_MODE_CONFLICT",
          severity: "error",
          path: `/stages/${index}/fixer/role`,
          message: "fixLoop fixer role must be edit mode.",
          suggestions: ["Use an implementation role with mode edit for fixer."]
        }));
      }
    }
    if (stage.kind === "reduce" && stage.mode === "agent" && stage.role && spec.roles[stage.role]?.mode === "edit") {
      issues.push(issue({
        code: "ROLE_MODE_CONFLICT",
        severity: "error",
        path: `/stages/${index}/role`,
        message: `Agent reduce stage ${stage.id} must not use an edit role.`,
        suggestions: ["Use a readOnly review/validation role for reduce, or switch to mode program for mechanical aggregation."]
      }));
    }
    if (stage.kind === "decisionGate" && stage.mode === "agent" && stage.role && spec.roles[stage.role]?.mode === "edit") {
      issues.push(issue({
        code: "ROLE_MODE_CONFLICT",
        severity: "error",
        path: `/stages/${index}/role`,
        message: `Agent decisionGate stage ${stage.id} must not use an edit role.`,
        suggestions: ["Use a readOnly coordination/review role for semantic routing decisions."]
      }));
    }
  }
  void stages;
  return issues;
}

function lintVariables(spec: WorkflowSpec, stages: Map<string, Stage>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const ancestors = computeAncestors(spec);
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    const stageVariables = stageVariablesForLint(stage);
    if (stage.prompt) {
      const variableIssues = findVariableIssues(stage.prompt, stageVariables);
      pushVariablePromptIssues(issues, variableIssues, `/stages/${index}/prompt`, `/stages/${index}/variables`);
    }
    if (stage.kind === "fanout") {
      for (let groupIndex = 0; groupIndex < stage.laneGroups.length; groupIndex += 1) {
        const group = stage.laneGroups[groupIndex];
        for (let laneIndex = 0; laneIndex < group.lanes.length; laneIndex += 1) {
          const lane = group.lanes[laneIndex];
          const prompt = lane.prompt ?? stage.prompt;
          if (!prompt) {
            issues.push(issue({
              code: "FANOUT_LANE_PROMPT_REQUIRED",
              severity: "error",
              path: `/stages/${index}/laneGroups/${groupIndex}/lanes/${laneIndex}/prompt`,
              message: `Fanout lane ${group.id}/${lane.id} must declare prompt or inherit the fanout stage prompt.`,
              suggestions: ["Add a stage prompt shared by all lanes, or add prompt to this lane."]
            }));
            continue;
          }
          pushVariablePromptIssues(
            issues,
            findVariableIssues(prompt, stage.variables ?? []),
            lane.prompt ? `/stages/${index}/laneGroups/${groupIndex}/lanes/${laneIndex}/prompt` : `/stages/${index}/prompt`,
            `/stages/${index}/variables`
          );
        }
      }
    }
    if (stage.kind === "fixLoop") {
      pushVariablePromptIssues(
        issues,
        findVariableIssues(stage.validator.prompt, stage.validator.variables ?? []),
        `/stages/${index}/validator/prompt`,
        `/stages/${index}/validator/variables`
      );
      pushVariablePromptIssues(
        issues,
        findVariableIssues(stage.fixer.prompt, stage.fixer.variables ?? []),
        `/stages/${index}/fixer/prompt`,
        `/stages/${index}/fixer/variables`
      );
    }
    for (let varIndex = 0; varIndex < stageVariables.length; varIndex += 1) {
      const variable = stageVariables[varIndex];
      try {
        const parsed = parseSourcePath(variable.source);
        if (parsed.root === "input" && !spec.inputs[parsed.parts[0] ?? ""]) {
          issues.push(issue({
            code: "VARIABLE_SOURCE_UNKNOWN",
            severity: "error",
            path: `/stages/${index}/variables/${varIndex}/source`,
            message: `Unknown input source ${variable.source}.`,
            suggestions: [`Declare /inputs/${parsed.parts[0]}.`]
          }));
        }
        if (parsed.root === "outputs") {
          const sourceStage = parsed.parts[0];
          if (!sourceStage || !stages.has(sourceStage)) {
            issues.push(issue({
              code: "VARIABLE_SOURCE_UNKNOWN",
              severity: "error",
              path: `/stages/${index}/variables/${varIndex}/source`,
              message: `Unknown output source ${variable.source}.`,
              suggestions: ["Reference outputs from an existing upstream stage."]
            }));
          } else if (!ancestors.get(stage.id)?.has(sourceStage)) {
            issues.push(issue({
              code: "VARIABLE_SOURCE_NOT_DEPENDED",
              severity: "error",
              path: `/stages/${index}/variables/${varIndex}/source`,
              message: `Stage ${stage.id} reads ${sourceStage}, but does not depend on it.`,
              suggestions: [`Add "${sourceStage}" to /stages/${index}/dependsOn or move the stage after ${sourceStage}.`]
            }));
          }
        }
      } catch (error) {
        issues.push(issue({
          code: "VARIABLE_SOURCE_INVALID",
          severity: "error",
          path: `/stages/${index}/variables/${varIndex}/source`,
          message: (error as Error).message,
          suggestions: ["Use a restricted dotted source path such as input.task or outputs.plan.summary."]
        }));
      }
    }
  }
  return issues;
}

function pushVariablePromptIssues(
  issues: OrchestratorIssue[],
  variableIssues: ReturnType<typeof findVariableIssues>,
  promptPath: string,
  variablesPath: string
): void {
  for (const name of variableIssues.missing) {
    issues.push(issue({
      code: "VARIABLE_UNDECLARED",
      severity: "error",
      path: promptPath,
      message: `Prompt references \${${name}}, but no variable named ${name} is declared.`,
      suggestions: [`Add a variable named ${name} to ${variablesPath}, or remove the placeholder.`]
    }));
  }
  for (const name of variableIssues.unused) {
    issues.push(issue({
      code: "VARIABLE_UNUSED",
      severity: "warning",
      path: variablesPath,
      message: `Variable ${name} is declared but not used by the prompt.`,
      suggestions: [`Remove variable ${name}, or reference it as \${${name}}.`]
    }));
  }
  for (const name of variableIssues.duplicates) {
    issues.push(issue({
      code: "VARIABLE_DUPLICATE",
      severity: "error",
      path: variablesPath,
      message: `Variable ${name} is declared more than once.`,
      suggestions: ["Rename or remove duplicate variable declarations."]
    }));
  }
}

function lintLimits(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (!stage.limits) continue;
    if (stage.limits.maxConcurrency !== undefined && stage.kind !== "fanout") {
      issues.push(issue({
        code: "LIMIT_STAGE_CONCURRENCY_UNSUPPORTED",
        severity: "error",
        path: `/stages/${index}/limits/maxConcurrency`,
        message: `Stage ${stage.id} is ${stage.kind}, so it cannot declare maxConcurrency.`,
        suggestions: ["Move maxConcurrency onto a fanout stage that introduces concurrent item work."]
      }));
    }
    if (stage.limits.maxFanoutItems !== undefined && stage.kind !== "fanout") {
      issues.push(issue({
        code: "LIMIT_STAGE_FANOUT_ITEMS_UNSUPPORTED",
        severity: "error",
        path: `/stages/${index}/limits/maxFanoutItems`,
        message: `Stage ${stage.id} is ${stage.kind}, so it cannot declare maxFanoutItems.`,
        suggestions: ["Move maxFanoutItems onto the fanout stage that consumes the item source."]
      }));
    }
    if (spec.limits.stageTimeoutMinutes && stage.limits.stageTimeoutMinutes && stage.limits.stageTimeoutMinutes > spec.limits.stageTimeoutMinutes) {
      issues.push(issue({
        code: "LIMIT_STAGE_EXCEEDS_GLOBAL",
        severity: "error",
        path: `/stages/${index}/limits/stageTimeoutMinutes`,
        message: `Stage ${stage.id} stageTimeoutMinutes exceeds workflow stageTimeoutMinutes.`,
        suggestions: ["Lower the stage timeout or raise the top-level timeout intentionally."]
      }));
    }
  }
  return issues;
}

function lintDecisionGates(spec: WorkflowSpec, stages: Map<string, Stage>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const ancestors = computeAncestors(spec);
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind !== "decisionGate") continue;
    for (let ruleIndex = 0; ruleIndex < stage.rules.length; ruleIndex += 1) {
      const target = stage.rules[ruleIndex].to;
      if (target !== "blocked" && !stages.has(target)) {
        issues.push(issue({
          code: "DECISION_TARGET_UNKNOWN",
          severity: "error",
          path: `/stages/${index}/rules/${ruleIndex}/to`,
          message: `Decision rule targets unknown stage ${target}.`,
          suggestions: ["Use an existing stage id or blocked."]
        }));
      } else if (target !== "blocked" && !ancestors.get(target)?.has(stage.id)) {
        issues.push(issue({
          code: "DECISION_TARGET_DEPENDENCY_UNSATISFIED",
          severity: "error",
          path: `/stages/${index}/rules/${ruleIndex}/to`,
          message: `Decision rule targets ${target}, but ${target} does not depend on ${stage.id}.`,
          suggestions: [`Add "${stage.id}" to ${target}.dependsOn or route to a stage that is downstream of ${stage.id}.`]
        }));
      }
    }
    if (stage.default !== "blocked" && !stages.has(stage.default)) {
      issues.push(issue({
        code: "DECISION_DEFAULT_UNKNOWN",
        severity: "error",
        path: `/stages/${index}/default`,
        message: `Decision default targets unknown stage ${stage.default}.`,
        suggestions: ["Use an existing stage id or blocked."]
      }));
    } else if (stage.default !== "blocked" && !ancestors.get(stage.default)?.has(stage.id)) {
      issues.push(issue({
        code: "DECISION_TARGET_DEPENDENCY_UNSATISFIED",
        severity: "error",
        path: `/stages/${index}/default`,
        message: `Decision default targets ${stage.default}, but ${stage.default} does not depend on ${stage.id}.`,
        suggestions: [`Add "${stage.id}" to ${stage.default}.dependsOn or make the default blocked.`]
      }));
    }
    if (stage.default !== "blocked") {
      issues.push(issue({
        code: "DECISION_NON_BLOCKED_DEFAULT",
        severity: "warning",
        path: `/stages/${index}/default`,
        message: `Decision ${stage.id} uses non-blocked default route ${stage.default}.`,
        suggestions: ["Confirm this fallback is intentional; use blocked for safer unmatched cases."]
      }));
    }
  }
  return issues;
}

function lintGates(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind !== "gate") continue;
    if (stage.mode === "program" && !stage.condition && (stage.dependsOn ?? []).length !== 1) {
      issues.push(issue({
        code: "GATE_PROGRAM_CONDITION_REQUIRED",
        severity: "error",
        path: `/stages/${index}`,
        message: `Program gate ${stage.id} without an explicit condition must have exactly one upstream dependency.`,
        suggestions: ["Add a condition, or make the gate depend on exactly one upstream stage."]
      }));
    }
  }
  return issues;
}

function lintFanout(spec: WorkflowSpec, stages: Map<string, Stage>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind !== "fanout") continue;
    const groupIds = new Set<string>();
    const contracts = new Set<string>();
    let hasEditLane = false;
    for (let groupIndex = 0; groupIndex < stage.laneGroups.length; groupIndex += 1) {
      const group = stage.laneGroups[groupIndex];
      if (groupIds.has(group.id)) {
        issues.push(issue({
          code: "FANOUT_LANE_GROUP_DUPLICATE",
          severity: "error",
          path: `/stages/${index}/laneGroups/${groupIndex}/id`,
          message: `Duplicate fanout lane group id: ${group.id}`,
          suggestions: ["Give every lane group in the fanout stage a unique id."]
        }));
      }
      groupIds.add(group.id);
      const laneIds = new Set<string>();
      const defaultLanes = group.lanes.filter((lane) => lane.default === true);
      if (group.mode === "oneOf" && defaultLanes.length > 1) {
        issues.push(issue({
          code: "FANOUT_ONE_OF_DEFAULT_DUPLICATE",
          severity: "error",
          path: `/stages/${index}/laneGroups/${groupIndex}/lanes`,
          message: `Fanout oneOf group ${group.id} declares more than one default lane.`,
          suggestions: ["Keep at most one default lane in a oneOf group."]
        }));
      }
      for (let laneIndex = 0; laneIndex < group.lanes.length; laneIndex += 1) {
        const lane = group.lanes[laneIndex];
        if (laneIds.has(lane.id)) {
          issues.push(issue({
            code: "FANOUT_LANE_DUPLICATE",
            severity: "error",
            path: `/stages/${index}/laneGroups/${groupIndex}/lanes/${laneIndex}/id`,
            message: `Duplicate fanout lane id in group ${group.id}: ${lane.id}`,
            suggestions: ["Lane ids only need to be unique within their group."]
          }));
        }
        laneIds.add(lane.id);
        if (group.mode === "all" && lane.default === true) {
          issues.push(issue({
            code: "FANOUT_DEFAULT_INVALID",
            severity: "error",
            path: `/stages/${index}/laneGroups/${groupIndex}/lanes/${laneIndex}/default`,
            message: `Fanout all group ${group.id} cannot declare a default lane.`,
            suggestions: ["Remove default from this lane, or change the group mode to oneOf."]
          }));
        }
        if (group.mode === "oneOf" && lane.default === true && lane.when) {
          issues.push(issue({
            code: "FANOUT_DEFAULT_WHEN_INVALID",
            severity: "error",
            path: `/stages/${index}/laneGroups/${groupIndex}/lanes/${laneIndex}/when`,
            message: `Fanout default lane ${group.id}/${lane.id} cannot declare when.`,
            suggestions: ["Default lanes are unconditional fallbacks; remove when."]
          }));
        }
        if (group.mode === "oneOf" && lane.default !== true && !lane.when) {
          issues.push(issue({
            code: "FANOUT_ONE_OF_WHEN_REQUIRED",
            severity: "error",
            path: `/stages/${index}/laneGroups/${groupIndex}/lanes/${laneIndex}/when`,
            message: `Fanout oneOf lane ${group.id}/${lane.id} must declare when unless it is default.`,
            suggestions: ["Add a condition or mark exactly one fallback lane as default."]
          }));
        }
        const role = spec.roles[lane.role];
        if (role) {
          contracts.add(contractNameForStage(stage, role));
          hasEditLane ||= role.mode === "edit";
        }
      }
    }
    if (contracts.size > 1) {
      issues.push(issue({
        code: "FANOUT_CONTRACT_MISMATCH",
        severity: "error",
        path: `/stages/${index}/laneGroups`,
        message: `Fanout stage ${stage.id} lanes resolve to multiple output contracts: ${[...contracts].join(", ")}.`,
        suggestions: ["Use lane roles with the same role category contract in one fanout stage."]
      }));
    }
    if (hasEditLane) {
      issues.push(issue({
        code: "FANOUT_EDIT_HIGH_RISK",
        severity: "warning",
        path: `/stages/${index}`,
        message: `Edit fanout ${stage.id} is high risk and may produce overlapping file changes.`,
        suggestions: ["Use disjoint item scopes and ensure a readOnly reduce/reconcile stage follows the fanout."]
      }));
      const hasReconcile = spec.stages.some((candidate) => {
        if (candidate.kind !== "reduce" || candidate.from !== stage.id) return false;
        const reduceRole = candidate.role ? spec.roles[candidate.role] : undefined;
        return candidate.mode === "program" || reduceRole?.mode === "readOnly";
      });
      if (!hasReconcile) {
        issues.push(issue({
          code: "FANOUT_EDIT_RECONCILE_MISSING",
          severity: "error",
          path: `/stages/${index}`,
          message: `Edit fanout ${stage.id} must be followed by a readOnly reduce/reconcile stage.`,
          suggestions: [`Add a reduce stage with from "${stage.id}" and a readOnly role before gate.`]
        }));
      }
    }
  }
  void stages;
  return issues;
}

function lintDiscover(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind !== "discover") continue;
    if (stage.method === "agent") {
      if (!stage.role) {
        issues.push(issue({
          code: "DISCOVER_AGENT_ROLE_REQUIRED",
          severity: "error",
          path: `/stages/${index}/role`,
          message: `Agent discover stage ${stage.id} requires a role.`,
          suggestions: ["Add a readOnly discovery/review role to the stage."]
        }));
      }
      if (!stage.prompt) {
        issues.push(issue({
          code: "DISCOVER_AGENT_PROMPT_REQUIRED",
          severity: "error",
          path: `/stages/${index}/prompt`,
          message: `Agent discover stage ${stage.id} requires a prompt.`,
          suggestions: ["Add a prompt that instructs the agent to end with a final JSON object containing discovered items."]
        }));
      }
      const role = stage.role ? spec.roles[stage.role] : undefined;
      if (role?.mode === "edit") {
        issues.push(issue({
          code: "ROLE_MODE_CONFLICT",
          severity: "error",
          path: `/stages/${index}/role`,
          message: `Agent discover stage ${stage.id} must not use an edit role.`,
          suggestions: ["Use a readOnly discovery/review role for agent discovery."]
        }));
      }
    }
  }
  return issues;
}

function stageRoles(stage: Stage): string[] {
  switch (stage.kind) {
    case "agentTask":
    case "summarize":
      return [stage.role];
    case "fanout":
      return stage.laneGroups.flatMap((group) => group.lanes.map((lane) => lane.role));
    case "discover":
      return stage.role ? [stage.role] : [];
    case "reduce":
      return stage.role ? [stage.role] : [];
    case "decisionGate":
      return stage.role ? [stage.role] : [];
    case "gate":
      return stage.role ? [stage.role] : [];
    case "fixLoop":
      return [stage.validator.role, stage.fixer.role];
  }
}

function stageVariablesForLint(stage: Stage) {
  if (stage.kind === "fixLoop") {
    return [...(stage.variables ?? []), ...(stage.validator.variables ?? []), ...(stage.fixer.variables ?? [])];
  }
  return stage.variables ?? [];
}

function computeAncestors(spec: WorkflowSpec): Map<string, Set<string>> {
  const byId = new Map(spec.stages.map((stage) => [stage.id, stage] as const));
  const cache = new Map<string, Set<string>>();
  const collect = (id: string): Set<string> => {
    const existing = cache.get(id);
    if (existing) return existing;
    const stage = byId.get(id);
    const result = new Set<string>();
    for (const dep of stage?.dependsOn ?? []) {
      result.add(dep);
      for (const ancestor of collect(dep)) result.add(ancestor);
    }
    cache.set(id, result);
    return result;
  };
  for (const stage of spec.stages) collect(stage.id);
  return cache;
}
