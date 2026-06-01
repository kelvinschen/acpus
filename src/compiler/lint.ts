import { issue, type OrchestratorIssue } from "../errors.js";
import { estimateAgentCalls } from "../projections/run-view.js";
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

  const summarize = spec.stages.filter((stage) => stage.kind === "summarize");
  if (summarize.length !== 1) {
    issues.push(issue({
      code: "GRAPH_SUMMARIZE_COUNT_INVALID",
      severity: "error",
      path: "/stages",
      message: `Workflow must have exactly one summarize stage; found ${summarize.length}.`,
      suggestions: ["Add exactly one final summarize stage with role summarizer."]
    }));
  }
  if (summarize.length === 1) {
    const summarizerDependents = spec.stages.filter((stage) => (stage.dependsOn ?? []).includes(summarize[0].id));
    if (summarizerDependents.length > 0) {
      issues.push(issue({
        code: "GRAPH_SUMMARIZE_NOT_TERMINAL",
        severity: "error",
        path: "/stages",
        message: `Summarize stage ${summarize[0].id} must be terminal, but ${summarizerDependents.length} stage(s) depend on it.`,
        suggestions: ["Move all downstream work before summarize; summarize is the final normal-completion stage."]
      }));
    }
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
    if (stage.kind === "summarize") {
      const role = spec.roles.summarizer;
      if (!role || role.category !== "summarization" || role.mode !== "readOnly") {
        issues.push(issue({
          code: "ROLE_SUMMARIZER_INVALID",
          severity: "error",
          path: "/roles/summarizer",
          message: "Summarize stage requires /roles/summarizer with category summarization and mode readOnly.",
          suggestions: ["Add roles.summarizer with category summarization, agent claude, and mode readOnly."]
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
  const plannedAgentCalls = estimateAgentCalls(spec);
  if (spec.limits.maxAgents && plannedAgentCalls > spec.limits.maxAgents) {
    issues.push(issue({
      code: "LIMIT_MAX_AGENTS_EXCEEDED",
      severity: "error",
      path: "/limits/maxAgents",
      message: `Planned worst-case agent calls (${plannedAgentCalls}) exceed workflow maxAgents (${spec.limits.maxAgents}).`,
      suggestions: ["Raise /limits/maxAgents intentionally, lower fanout/fixLoop limits, or split the workflow."]
    }));
  }
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (!stage.limits) continue;
    if (spec.limits.maxAgents && stage.limits.maxAgents && stage.limits.maxAgents > spec.limits.maxAgents) {
      issues.push(issue({
        code: "LIMIT_STAGE_EXCEEDS_GLOBAL",
        severity: "error",
        path: `/stages/${index}/limits/maxAgents`,
        message: `Stage ${stage.id} maxAgents exceeds workflow maxAgents.`,
        suggestions: ["Lower the stage agent limit or raise the top-level limit intentionally."]
      }));
    }
    if (spec.limits.maxConcurrency && stage.limits.maxConcurrency && stage.limits.maxConcurrency > spec.limits.maxConcurrency) {
      issues.push(issue({
        code: "LIMIT_STAGE_EXCEEDS_GLOBAL",
        severity: "error",
        path: `/stages/${index}/limits/maxConcurrency`,
        message: `Stage ${stage.id} maxConcurrency exceeds workflow maxConcurrency.`,
        suggestions: ["Lower the stage limit or raise the top-level limit intentionally."]
      }));
    }
    if (spec.limits.maxFanoutItems && stage.limits.maxFanoutItems && stage.limits.maxFanoutItems > spec.limits.maxFanoutItems) {
      issues.push(issue({
        code: "LIMIT_STAGE_EXCEEDS_GLOBAL",
        severity: "error",
        path: `/stages/${index}/limits/maxFanoutItems`,
        message: `Stage ${stage.id} maxFanoutItems exceeds workflow maxFanoutItems.`,
        suggestions: ["Lower the stage limit or raise the top-level limit intentionally."]
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
    if (spec.limits.maxOutputChars && stage.limits.maxOutputChars && stage.limits.maxOutputChars > spec.limits.maxOutputChars) {
      issues.push(issue({
        code: "LIMIT_STAGE_EXCEEDS_GLOBAL",
        severity: "error",
        path: `/stages/${index}/limits/maxOutputChars`,
        message: `Stage ${stage.id} maxOutputChars exceeds workflow maxOutputChars.`,
        suggestions: ["Lower the stage output limit or raise the top-level limit intentionally."]
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

function lintFanout(spec: WorkflowSpec, stages: Map<string, Stage>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind !== "fanout") continue;
    const role = spec.roles[stage.role];
    if (role?.mode === "edit") {
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
          suggestions: [`Add a reduce stage with from "${stage.id}" and a readOnly role before summarize.`]
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
      if (!stage.limits?.maxFanoutItems && !spec.limits.maxFanoutItems) {
        issues.push(issue({
          code: "DISCOVER_AGENT_MAX_ITEMS_REQUIRED",
          severity: "error",
          path: `/stages/${index}/limits/maxFanoutItems`,
          message: `Agent discover stage ${stage.id} must have a declared item limit.`,
          suggestions: ["Set /limits/maxFanoutItems or /stages/<index>/limits/maxFanoutItems."]
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
    case "fanout":
    case "summarize":
      return [stage.role];
    case "discover":
      return stage.role ? [stage.role] : [];
    case "reduce":
      return stage.role ? [stage.role] : [];
    case "decisionGate":
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
