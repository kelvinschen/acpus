import { issue, type OrchestratorIssue } from "../errors.js";
import { declaredInputFields, validateInputSchema } from "../schema/input-validation.js";
import { validateLimitSources } from "../schema/limit-resolution.js";
import type { Stage, Variable, WorkflowSpec } from "../schema/workflow-spec.js";
import { findVariableIssues } from "../variables/interpolate.js";
import { parseSourcePath } from "../variables/paths.js";
import { compileSchemaDsl } from "../contracts/schema-dsl.js";

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
  issues.push(...lintVariables(spec, stages));
  issues.push(...lintActors(spec));
  issues.push(...lintOutputSchemas(spec));
  issues.push(...lintRoutes(spec, stages));
  issues.push(...lintFanout(spec));
  issues.push(...lintPrograms(spec));
  issues.push(...lintLoops(spec));
  issues.push(...validateInputSchema(spec));
  issues.push(...validateLimitSources(spec));
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

  const gates = spec.stages.filter((stage) => stage.kind === "gate");
  if (gates.length !== 1) {
    issues.push(issue({
      code: "GRAPH_GATE_COUNT_INVALID",
      severity: "error",
      path: "/stages",
      message: `Workflow must have exactly one gate stage; found ${gates.length}.`,
      suggestions: ["Add exactly one final gate stage as the terminal completion signal."]
    }));
  }

  const dependents = dependentsByStage(spec);
  for (const stage of spec.stages) {
    for (const dep of stage.dependsOn ?? []) {
      if (!stages.has(dep)) {
        issues.push(issue({
          code: "GRAPH_UNKNOWN_DEPENDENCY",
          severity: "error",
          path: "/stages",
          message: `Stage ${stage.id} depends on unknown stage ${dep}.`,
          suggestions: [`Add a stage named ${dep}, or remove it from dependsOn.`]
        }));
      }
    }
    const next = dependents.get(stage.id) ?? [];
    if (next.length > 1 && stage.kind !== "route") {
      issues.push(issue({
        code: "GRAPH_BRANCH_REQUIRES_ROUTE",
        severity: "error",
        path: "/stages",
        message: `Stage ${stage.id} has multiple dependents (${next.join(", ")}), but only route may branch.`,
        suggestions: ["Insert an explicit route stage before branching."]
      }));
    }
    if (next.length === 0 && stage.kind !== "gate") {
      issues.push(issue({
        code: "GRAPH_NON_GATE_TERMINAL",
        severity: "error",
        path: "/stages",
        message: `Stage ${stage.id} is terminal, but only gate may be the terminal workflow stage.`,
        suggestions: ["Add a terminal gate depending on this stage."]
      }));
    }
  }

  for (const gate of gates) {
    const next = dependents.get(gate.id) ?? [];
    if (next.length > 0) {
      issues.push(issue({
        code: "GRAPH_GATE_NOT_TERMINAL",
        severity: "error",
        path: "/stages",
        message: `Gate stage ${gate.id} must be terminal, but ${next.length} stage(s) depend on it.`,
        suggestions: ["Move all downstream work before the terminal gate."]
      }));
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
        suggestions: ["Remove the cycle. Use loop for bounded loops."]
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
  return issues;
}

function lintActors(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind === "route" && stage.mode === "agent") {
      if (!stage.actor) issues.push(requiredIssue("ROUTE_AGENT_ACTOR_REQUIRED", `/stages/${index}/actor`, `Agent route ${stage.id} requires actor.`));
      if (!stage.prompt) issues.push(requiredIssue("ROUTE_AGENT_PROMPT_REQUIRED", `/stages/${index}/prompt`, `Agent route ${stage.id} requires prompt.`));
      if (stage.actor?.mode === "edit") issues.push(modeConflict(`/stages/${index}/actor/mode`, `Agent route ${stage.id} must use readOnly or denyAll actor mode.`));
    }
    if (stage.kind === "gate" && stage.mode === "agent") {
      if (!stage.actor) issues.push(requiredIssue("GATE_AGENT_ACTOR_REQUIRED", `/stages/${index}/actor`, `Agent gate ${stage.id} requires actor.`));
      if (!stage.prompt) issues.push(requiredIssue("GATE_AGENT_PROMPT_REQUIRED", `/stages/${index}/prompt`, `Agent gate ${stage.id} requires prompt.`));
      if (stage.actor?.mode === "edit") issues.push(modeConflict(`/stages/${index}/actor/mode`, `Agent gate ${stage.id} must use readOnly or denyAll actor mode.`));
    }
    if (stage.kind === "fanout") {
      for (let laneIndex = 0; laneIndex < stage.lanes.length; laneIndex += 1) {
        const lane = stage.lanes[laneIndex];
        if (!lane.prompt && !stage.prompt) {
          issues.push(requiredIssue(
            "FANOUT_LANE_PROMPT_REQUIRED",
            `/stages/${index}/lanes/${laneIndex}/prompt`,
            `Fanout lane ${lane.id} must declare prompt or inherit the fanout prompt.`
          ));
        }
      }
      if (stage.fanin.mode === "agent" && stage.fanin.actor.mode === "edit") {
        issues.push(modeConflict(`/stages/${index}/fanin/actor/mode`, `Agent fanin ${stage.id} must use readOnly or denyAll actor mode.`));
      }
    }
  }
  return issues;
}

function lintOutputSchemas(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const check = (schema: string | undefined, path: string): void => {
    if (!schema) return;
    try {
      compileSchemaDsl(schema);
    } catch (error) {
      issues.push(issue({
        code: "OUTPUT_SCHEMA_DSL_INVALID",
        severity: "error",
        path,
        message: `Schema DSL is invalid: ${(error as Error).message}`,
        suggestions: ["Use primitives, literals, arrays, objects, optional keys, and unions only."]
      }));
    }
  };
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind === "task" && stage.mode === "agent") check(stage.output?.schema, `/stages/${index}/output/schema`);
    if (stage.kind === "gate" && stage.mode === "agent") check(stage.output?.schema, `/stages/${index}/output/schema`);
    if (stage.kind === "fanout") {
      for (let laneIndex = 0; laneIndex < stage.lanes.length; laneIndex += 1) {
        check(stage.lanes[laneIndex].output?.schema, `/stages/${index}/lanes/${laneIndex}/output/schema`);
      }
      if (stage.fanin.mode === "agent") check(stage.fanin.output?.schema, `/stages/${index}/fanin/output/schema`);
    }
  }
  return issues;
}

function lintRoutes(spec: WorkflowSpec, stages: Map<string, Stage>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const dependents = dependentsByStage(spec);
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind !== "route") continue;
    const next = new Set(dependents.get(stage.id) ?? []);
    const routes = new Set(stage.routes);
    const missing = [...next].filter((id) => !routes.has(id));
    const extra = [...routes].filter((id) => !next.has(id));
    if (missing.length > 0 || extra.length > 0) {
      issues.push(issue({
        code: "ROUTE_ROUTES_MISMATCH",
        severity: "error",
        path: `/stages/${index}/routes`,
        message: `Route ${stage.id} routes must exactly match direct downstream stages.`,
        suggestions: [`Use routes: [${[...next].join(", ")}].`]
      }));
    }
    for (const route of stage.routes) {
      if (!stages.has(route)) {
        issues.push(issue({
          code: "ROUTE_TARGET_UNKNOWN",
          severity: "error",
          path: `/stages/${index}/routes`,
          message: `Route ${stage.id} references unknown target ${route}.`,
          suggestions: [`Add a downstream stage ${route}, or remove it from routes.`]
        }));
      }
    }
  }
  return issues;
}

function lintFanout(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind !== "fanout") continue;
    if (!stage.fanin) {
      issues.push(issue({
        code: "FANOUT_FANIN_REQUIRED",
        severity: "error",
        path: `/stages/${index}/fanin`,
        message: `Fanout ${stage.id} must declare fanin.`,
        suggestions: ["Add an agent fanin or program fanin operation mergeArrays."]
      }));
    }
  }
  return issues;
}

function lintPrograms(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind === "task" && stage.mode === "program" && stage.operation !== "command") {
      issues.push(issue({
        code: "PROGRAM_TASK_OPERATION_UNKNOWN",
        severity: "error",
        path: `/stages/${index}/operation`,
        message: `Program task ${stage.id} uses unsupported operation ${String(stage.operation)}.`,
        suggestions: ["Use operation: command."]
      }));
    }
  }
  return issues;
}

function lintLoops(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    if (stage.kind !== "loop") continue;
    const outputStage = stage.body.stages.find((candidate) => candidate.id === stage.body.output);
    if (!outputStage) {
      issues.push(issue({
        code: "LOOP_BODY_OUTPUT_UNKNOWN",
        severity: "error",
        path: `/stages/${index}/body/output`,
        message: `Loop ${stage.id} body output ${stage.body.output} does not match a body stage.`,
        suggestions: ["Set body.output to a task or fanout stage id."]
      }));
    } else if (outputStage.kind === "route") {
      issues.push(issue({
        code: "LOOP_BODY_OUTPUT_ROUTE_INVALID",
        severity: "error",
        path: `/stages/${index}/body/output`,
        message: `Loop ${stage.id} body output cannot be route stage ${outputStage.id}.`,
        suggestions: ["Set body.output to a task or fanout stage id."]
      }));
    }
  }
  return issues;
}

function lintVariables(spec: WorkflowSpec, _stages: Map<string, Stage>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const inputFields = declaredInputFields(spec);
  const checkVariables = (stage: Stage, pathPrefix: string): void => {
    const variables = "variables" in stage ? stage.variables ?? [] : [];
    const prompts: Array<{ path: string; text: string; implicitVariables?: Stage["variables"] }> = [];
    if ("prompt" in stage && typeof stage.prompt === "string") prompts.push({ path: `${pathPrefix}/prompt`, text: stage.prompt });
    if (stage.kind === "fanout") {
      for (let laneIndex = 0; laneIndex < stage.lanes.length; laneIndex += 1) {
        const prompt = stage.lanes[laneIndex].prompt;
        if (prompt) prompts.push({ path: `${pathPrefix}/lanes/${laneIndex}/prompt`, text: prompt });
      }
      if (stage.fanin.mode === "agent") {
        for (let varIndex = 0; varIndex < variables.length; varIndex += 1) {
          const variable = variables[varIndex];
          if (variable.name === "results") {
            issues.push(issue({
              code: "VARIABLE_RESERVED",
              severity: "error",
              path: `${pathPrefix}/variables/${varIndex}/name`,
              message: "Agent fanin reserves the variable name results for the fanout aggregate.",
              suggestions: ["Rename the workflow variable; use ${results} in fanin prompts for the fanout aggregate."]
            }));
          }
        }
        prompts.push({
          path: `${pathPrefix}/fanin/prompt`,
          text: stage.fanin.prompt,
          implicitVariables: [{ name: "results", source: "results" }]
        });
        for (const variable of variables.filter((entry) => isItemScopedVariable(entry))) {
          if (stage.fanin.prompt.includes(`\${${variable.name}}`)) {
            issues.push(issue({
              code: "VARIABLE_UNDECLARED",
              severity: "error",
              path: `${pathPrefix}/fanin/prompt`,
              message: `Agent fanin prompt references item-scoped variable ${variable.name}, but fanin does not run with an item context.`,
              suggestions: ["Use ${results} to inspect fanout item and lane outputs, or reference input/output scoped variables."]
            }));
          }
        }
      }
    }
    for (const prompt of prompts) {
      const scopedVariables = prompt.path.endsWith("/fanin/prompt")
        ? variables.filter((variable) => !isItemScopedVariable(variable) && variable.name !== "results")
        : variables;
      const variableIssues = findVariableIssues(prompt.text, [...scopedVariables, ...(prompt.implicitVariables ?? [])]);
      for (const missing of variableIssues.missing) {
        issues.push(issue({
          code: "VARIABLE_UNDECLARED",
          severity: "error",
          path: prompt.path,
          message: `Prompt references undeclared variable ${missing}.`,
          suggestions: [`Declare the missing variable under ${pathPrefix}/variables.`]
        }));
      }
      for (const duplicate of variableIssues.duplicates) {
        issues.push(issue({
          code: "VARIABLE_DUPLICATE",
          severity: "error",
          path: `${pathPrefix}/variables`,
          message: `Variable ${duplicate} is declared more than once.`,
          suggestions: ["Declare each variable name once."]
        }));
      }
    }
    for (let varIndex = 0; varIndex < variables.length; varIndex += 1) {
      const variable = variables[varIndex];
      try {
        const parsed = parseSourcePath(variable.source);
        if (parsed.root === "input" && inputFields && !inputFields.has(parsed.parts[0] ?? "")) {
          issues.push(issue({
            code: "VARIABLE_SOURCE_UNKNOWN",
            severity: "error",
            path: `${pathPrefix}/variables/${varIndex}/source`,
            message: `Unknown input source ${variable.source}.`,
            suggestions: [`Declare ${parsed.parts[0]} in /input/schema.`]
          }));
        }
      } catch (error) {
        issues.push(issue({
          code: "VARIABLE_SOURCE_INVALID",
          severity: "error",
          path: `${pathPrefix}/variables/${varIndex}/source`,
          message: (error as Error).message,
          suggestions: ["Use input.*, outputs.*, item.*, loop.*, or results variable sources."]
        }));
      }
    }
  };
  for (let index = 0; index < spec.stages.length; index += 1) {
    const stage = spec.stages[index];
    checkVariables(stage, `/stages/${index}`);
    if (stage.kind === "loop") {
      for (let bodyIndex = 0; bodyIndex < stage.body.stages.length; bodyIndex += 1) {
        checkVariables(stage.body.stages[bodyIndex] as Stage, `/stages/${index}/body/stages/${bodyIndex}`);
      }
    }
  }
  return issues;
}

function isItemScopedVariable(variable: Variable): boolean {
  return variable.source === "item" || variable.source.startsWith("item.");
}

function dependentsByStage(spec: Pick<WorkflowSpec, "stages">): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const stage of spec.stages) {
    for (const dep of stage.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(stage.id);
      dependents.set(dep, list);
    }
  }
  return dependents;
}

function requiredIssue(code: string, path: string, message: string): OrchestratorIssue {
  return issue({ code, severity: "error", path, message, suggestions: ["Declare the missing required field."] });
}

function modeConflict(path: string, message: string): OrchestratorIssue {
  return issue({
    code: "ACTOR_MODE_CONFLICT",
    severity: "error",
    path,
    message,
    suggestions: ["Use readOnly or denyAll for orchestration-only agent stages."]
  });
}
