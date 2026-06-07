import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { parse as parseYaml } from "yaml";
import { DiagnosticBag } from "./diagnostics.js";
import { createExpressionCollector } from "./expressions.js";
import { createSchedule } from "./schedule.js";
import { compileSchemaDsl } from "./schema/index.js";
import { parseDurationMs } from "./duration.js";
import type {
  AcpusIr,
  AgentSpec,
  CompileOptions,
  CompileResult,
  IrBranch,
  IrNode,
  IrNodeKind,
  LintResult,
  NodeKeyTemplate,
  WorkflowSpec,
  WorkflowStep
} from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false });

export function compileWorkflow(source: string, options: CompileOptions = {}): CompileResult {
  const diagnostics = new DiagnosticBag();
  const parsed = parseSource(source, diagnostics);

  if (!isWorkflowSpec(parsed)) {
    diagnostics.error("SPEC_SHAPE", "Workflow spec must be a YAML object with version, name, and workflow.steps.", "$");
    return result(false, diagnostics);
  }

  const expanded = expandIncludes(parsed, options, diagnostics, new Set());
  const stepIds = collectStepIds(expanded.workflow.steps, diagnostics);
  const context: CompileContext = {
    diagnostics,
    stepIds,
    agents: isRecord(expanded.agents) ? expanded.agents : {},
    sourcePath: options.sourcePath
  };

  validateSpec(expanded, context);
  const rootChildren = compileSteps(expanded.workflow.steps, ["workflow"], "$.workflow.steps", context);
  const root: IrNode = {
    id: "workflow",
    kind: "pipeline",
    nodePath: ["workflow"],
    keyTemplate: keyTemplate(["workflow"]),
    children: rootChildren,
    metadata: {
      implicit: true
    }
  };

  const expressionCollector = createExpressionCollector(diagnostics, stepIds);
  expressionCollector.visit(expanded.input ?? {}, "$.input");
  expressionCollector.visit(expanded.agents ?? {}, "$.agents");
  expressionCollector.visit(expanded.workflow.steps, "$.workflow.steps");
  expressionCollector.visit(expanded.outputs ?? {}, "$.outputs");

  const ok = !diagnostics.hasErrors(options.strict);
  if (!ok) {
    return result(false, diagnostics);
  }

  const ir: AcpusIr = {
    irVersion: 1,
    astVersion: 1,
    source: {
      path: options.sourcePath,
      digest: digest(source)
    },
    name: expanded.name,
    description: expanded.description,
    input: expanded.input ?? {},
    agents: expanded.agents ?? {},
    root,
    outputs: expanded.outputs ?? {},
    expressions: expressionCollector.expressions
  };

  return {
    ok: true,
    diagnostics: diagnostics.diagnostics,
    ir,
    schedule: createSchedule(ir)
  };
}

export function lintWorkflow(source: string, options: CompileOptions = {}): LintResult {
  const compiled = compileWorkflow(source, options);
  return {
    ok: compiled.ok,
    diagnostics: compiled.diagnostics
  };
}

interface CompileContext {
  diagnostics: DiagnosticBag;
  stepIds: Set<string>;
  agents: Record<string, unknown>;
  sourcePath?: string;
}

function parseSource(source: string, diagnostics: DiagnosticBag): unknown {
  try {
    return parseYaml(source);
  } catch (error) {
    diagnostics.error("YAML_PARSE", `Invalid YAML: ${errorMessage(error)}`, "$");
    return undefined;
  }
}

function expandIncludes(spec: WorkflowSpec, options: CompileOptions, diagnostics: DiagnosticBag, seen: Set<string>): WorkflowSpec {
  const steps: WorkflowStep[] = [];

  for (const [index, step] of spec.workflow.steps.entries()) {
    if (typeof step.include === "string") {
      if (!options.includeResolver) {
        diagnostics.error("INCLUDE_RESOLVER", "Include is present but no include resolver was provided.", `$.workflow.steps[${index}].include`);
        continue;
      }
      if (seen.has(step.include)) {
        diagnostics.error("INCLUDE_CYCLE", `Include cycle detected for '${step.include}'.`, `$.workflow.steps[${index}].include`);
        continue;
      }
      const includedSource = options.includeResolver(step.include, options.sourcePath);
      const includedParsed = parseSource(includedSource, diagnostics);
      if (!isWorkflowSpec(includedParsed)) {
        diagnostics.error("INCLUDE_SHAPE", `Included spec '${step.include}' is not a valid workflow spec.`, `$.workflow.steps[${index}].include`);
        continue;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(step.include);
      const expanded = expandIncludes(includedParsed, options, diagnostics, nextSeen);
      steps.push(...expanded.workflow.steps);
      continue;
    }
    steps.push(step);
  }

  return {
    ...spec,
    workflow: {
      ...spec.workflow,
      steps
    }
  };
}

function validateSpec(spec: WorkflowSpec, context: CompileContext): void {
  const { diagnostics } = context;
  if (spec.version !== 1) {
    diagnostics.error("SPEC_VERSION", "Only DSL version 1 is supported.", "$.version");
  }

  // Compile input flat-map to JSON Schema
  if (isRecord(spec.input)) {
    const { schema, errors } = compileSchemaDsl(spec.input, { strictObjectKeys: false });
    for (const err of errors) {
      diagnostics.error("INPUT_SHAPE", err.message, `$.input.${err.field}`);
    }
    if (errors.length === 0) {
      validateJsonSchema(schema, "$.input", context);
    }
    // Replace input with compiled schema in the spec so the IR stores the JSON Schema
    spec.input = schema;
  }

  if (!isRecord(spec.agents ?? {})) {
    diagnostics.error("AGENTS_SHAPE", "agents must be an object when present.", "$.agents");
  }

  for (const [agentName, agent] of Object.entries(spec.agents ?? {})) {
    if (!isRecord(agent)) {
      diagnostics.error("AGENT_SHAPE", `Agent '${agentName}' must be an object.`, `$.agents.${agentName}`);
      continue;
    }
    // `type` defaults to "builtin" when omitted.
    const type = agent.type ?? "builtin";
    if (type !== "builtin" && type !== "command" && type !== "mock") {
      diagnostics.error("AGENT_SHAPE", `Agent '${agentName}' type must be one of builtin, command, mock.`, `$.agents.${agentName}.type`);
    }
    // builtin/command require a non-empty `use` (adapter name or launch command).
    if ((type === "builtin" || type === "command") && (typeof agent.use !== "string" || agent.use.length === 0)) {
      diagnostics.error("AGENT_SHAPE", `Agent '${agentName}' (type ${type}) must define a non-empty use.`, `$.agents.${agentName}.use`);
    }
  }

  for (const [outputName, outputExpression] of Object.entries(spec.outputs ?? {})) {
    if (typeof outputExpression !== "string") {
      diagnostics.error("OUTPUT_SHAPE", `Output '${outputName}' must be an expression string.`, `$.outputs.${outputName}`);
    }
  }
}

function compileSteps(steps: WorkflowStep[], parentPath: string[], path: string, context: CompileContext): IrNode[] {
  return steps.map((step, index) => compileStep(step, parentPath, `${path}[${index}]`, context));
}

function compileStep(step: WorkflowStep, parentPath: string[], path: string, context: CompileContext): IrNode {
  const id = typeof step.id === "string" && step.id.length > 0 ? step.id : `missing_${parentPath.length}_${path}`;
  if (typeof step.id !== "string" || step.id.length === 0) {
    context.diagnostics.error("STEP_ID", "Every workflow step must define a non-empty string id.", `${path}.id`);
  }

  const nodePath = [...parentPath, id];
  const base = {
    id,
    nodePath,
    keyTemplate: keyTemplate(nodePath)
  };

  if (step.run === "agent") {
    validateAgentStep(step, path, context);
    validateStepTimeout(step, path, context);
    validateStepOnError(step, path, context);
    const metadata = pickMetadata(step, ["run", "use", "prompt", "output", "retry", "timeout", "on_error"]);
    // Snapshot the referenced agent definition into the node so the runtime can
    // route to the right executor and build the acpx invocation. `type` defaults
    // to "builtin".
    const agentName = typeof step.use === "string" ? step.use : undefined;
    const agentSpec = agentName ? context.agents[agentName] : undefined;
    if (isRecord(agentSpec)) {
      metadata.agent = { ...agentSpec, type: agentSpec.type ?? "builtin" };
    }
    return {
      ...base,
      kind: "run.agent",
      metadata
    };
  }

  if (step.run === "program") {
    validateProgramStep(step, path, context);
    validateStepTimeout(step, path, context);
    validateStepOnError(step, path, context);
    return {
      ...base,
      kind: "run.program",
      metadata: pickMetadata(step, ["run", "cmd", "env", "capture", "output", "retry", "timeout", "on_error"])
    };
  }

  if (Array.isArray(step.parallel)) {
    validateJoin(step.join, ["all", "race"], `${path}.join`, "parallel.join", context);
    return {
      ...base,
      kind: "parallel",
      keyTemplate: { ...keyTemplate(nodePath), parallelBranchId: true },
      outputMerge: "map",
      children: compileSteps(asSteps(step.parallel, `${path}.parallel`, context), nodePath, `${path}.parallel`, context),
      metadata: pickMetadata(step, ["max_concurrency", "join"])
    };
  }

  if (isRecord(step.fanout)) {
    const fanout = step.fanout;
    validateFanout(fanout, path, context);
    if (fanout.key === undefined) {
      context.diagnostics.warning("FANOUT_KEY", "fanout.key is missing; runtime will fall back to item index identity. Use key: \"${{ item.yourProperty }}\" to set a stable identity.", `${path}.fanout.key`);
    }
    const children = Array.isArray(fanout.do) ? compileSteps(asSteps(fanout.do, `${path}.fanout.do`, context), nodePath, `${path}.fanout.do`, context) : [];
    if (!Array.isArray(fanout.do)) {
      context.diagnostics.error("FANOUT_DO", "fanout.do must be an array of steps.", `${path}.fanout.do`);
    }
    return {
      ...base,
      kind: "fanout",
      keyTemplate: { ...keyTemplate(nodePath), fanoutItemId: true, laneId: true },
      outputMerge: "array",
      children,
      metadata: pickMetadata(fanout, ["over", "key", "max_concurrency", "join", "quorum", "success_criteria"])
    };
  }

  if (isRecord(step.switch)) {
    const switchSpec = step.switch;
    const branches: IrBranch[] = [];
    if (Array.isArray(switchSpec.cases)) {
      switchSpec.cases.forEach((caseSpec, caseIndex) => {
        if (!isRecord(caseSpec)) {
          context.diagnostics.error("SWITCH_CASE", "switch.cases entries must be objects.", `${path}.switch.cases[${caseIndex}]`);
          return;
        }
        // Coerce `when`: boolean → string, string → pass through, else error.
        if (caseSpec.when !== undefined) {
          if (typeof caseSpec.when === "boolean") {
            caseSpec.when = String(caseSpec.when);
          } else if (typeof caseSpec.when !== "string") {
            const typeDesc = caseSpec.when === null ? "null" : typeof caseSpec.when;
            context.diagnostics.error("SWITCH_WHEN_TYPE", `switch.case.when must be a boolean or CEL expression string, got ${typeDesc}.`, `${path}.switch.cases[${caseIndex}].when`);
          }
        }
        branches.push({
          id: `case_${caseIndex + 1}`,
          when: typeof caseSpec.when === "string" ? caseSpec.when : undefined,
          children: Array.isArray(caseSpec.do) ? compileSteps(asSteps(caseSpec.do, `${path}.switch.cases[${caseIndex}].do`, context), nodePath, `${path}.switch.cases[${caseIndex}].do`, context) : []
        });
      });
    } else {
      context.diagnostics.error("SWITCH_CASES", "switch.cases must be an array.", `${path}.switch.cases`);
    }
    if (isRecord(switchSpec.default)) {
      branches.push({
        id: "default",
        children: Array.isArray(switchSpec.default.do) ? compileSteps(asSteps(switchSpec.default.do, `${path}.switch.default.do`, context), nodePath, `${path}.switch.default.do`, context) : []
      });
    }
    return {
      ...base,
      kind: "switch",
      outputMerge: "selected",
      branches,
      metadata: pickMetadata(switchSpec, ["on"])
    };
  }

  if (isRecord(step.loop)) {
    const loop = step.loop;
    // Coerce `until`: boolean → string, string → pass through, else error.
    if (loop.until !== undefined) {
      if (typeof loop.until === "boolean") {
        loop.until = String(loop.until);
      } else if (typeof loop.until !== "string") {
        const typeDesc = loop.until === null ? "null" : typeof loop.until;
        context.diagnostics.error("LOOP_UNTIL_TYPE", `loop.until must be a boolean or CEL expression string, got ${typeDesc}.`, `${path}.loop.until`);
      }
    }
    if (typeof loop.max_iterations !== "number") {
      context.diagnostics.error("LOOP_MAX_ITERATIONS", "loop.max_iterations must be a number.", `${path}.loop.max_iterations`);
    }
    return {
      ...base,
      kind: "loop",
      keyTemplate: { ...keyTemplate(nodePath), loopRound: true },
      outputMerge: "last",
      children: Array.isArray(loop.do) ? compileSteps(asSteps(loop.do, `${path}.loop.do`, context), nodePath, `${path}.loop.do`, context) : [],
      metadata: pickMetadata(loop, ["until", "max_iterations"])
    };
  }

  if (isRecord(step.approval)) {
    validateApprovalStep(step.approval, path, context);
    return {
      ...base,
      kind: "approval",
      metadata: pickMetadata(step.approval, ["prompt", "timeout", "on_timeout"])
    };
  }

  if (typeof step.subworkflow === "string") {
    return {
      ...base,
      kind: "subworkflow",
      metadata: pickMetadata(step, ["subworkflow", "input"])
    };
  }

  context.diagnostics.error("STEP_KIND", "Step must define one of run: agent, run: program, parallel, fanout, switch, loop, approval, subworkflow, or include.", path);
  return {
    ...base,
    kind: "run.program",
    metadata: {}
  };
}

function validateAgentStep(step: WorkflowStep, path: string, context: CompileContext): void {
  if (typeof step.use !== "string") {
    context.diagnostics.error("AGENT_USE", "run: agent steps must define use.", `${path}.use`);
  } else if (!Object.prototype.hasOwnProperty.call(context.agents, step.use)) {
    context.diagnostics.error("AGENT_REF", `run: agent step references unknown agent '${step.use}'.`, `${path}.use`);
  }
  if (typeof step.prompt !== "string") {
    context.diagnostics.error("AGENT_PROMPT", "run: agent steps must define a prompt string.", `${path}.prompt`);
  }
  if ((step as Record<string, unknown>).retry !== undefined) {
    validateRetry((step as Record<string, unknown>).retry, path, context);
  }
  if (step.output !== undefined && !isRecord(step.output)) {
    context.diagnostics.error("OUTPUT_SHAPE", "run: agent output must be an object when present.", `${path}.output`);
  }
  if (isRecord(step.output)) {
    if ("schema" in step.output) {
      context.diagnostics.error("OUTPUT_SHAPE", "The 'schema' key in agent output is no longer supported as a JSON Schema escape hatch. Use the Acpus Schema DSL directly (e.g. output: { field: string }).", `${path}.output.schema`);
    }
    const { schema, errors } = compileSchemaDsl(step.output);
    for (const err of errors) {
      context.diagnostics.error("OUTPUT_SHAPE", err.message, `${path}.output.${err.field}`);
    }
    if (errors.length === 0) {
      validateJsonSchema(schema, `${path}.output`, context);
    }
    step.output = schema;
  }
}

function validateProgramStep(step: WorkflowStep, path: string, context: CompileContext): void {
  if (!Array.isArray(step.cmd) && typeof step.cmd !== "string") {
    context.diagnostics.error("PROGRAM_CMD", "run: program steps must define cmd as a string or array.", `${path}.cmd`);
  }
  if (step.capture !== undefined) {
    validateCapture(step.capture, path, context);
  }
  if (step.output !== undefined && !isRecord(step.output)) {
    context.diagnostics.error("OUTPUT_SHAPE", "run: program output must be an object when present.", `${path}.output`);
  }
  if (isRecord(step.output)) {
    if ("schema" in step.output) {
      context.diagnostics.error("OUTPUT_SHAPE", "The 'schema' key in program output is no longer supported as a JSON Schema escape hatch. Use the Acpus Schema DSL directly (e.g. output: { field: string }).", `${path}.output.schema`);
    }
    const { schema, errors } = compileSchemaDsl(step.output);
    for (const err of errors) {
      context.diagnostics.error("OUTPUT_SHAPE", err.message, `${path}.output.${err.field}`);
    }
    if (errors.length === 0) {
      validateJsonSchema(schema, `${path}.output`, context);
    }
    step.output = schema;
  }
  // Enforce: output schema requires capture.parse: json
  if (isRecord(step.output)) {
    const capture = step.capture as Record<string, unknown> | undefined;
    if (!capture || capture.parse !== "json") {
      context.diagnostics.error("OUTPUT_REQUIRES_JSON", "run: program output schema requires capture.parse: json.", `${path}.output`);
    }
  }
}

function validateFanout(fanout: Record<string, unknown>, path: string, context: CompileContext): void {
  if (fanout.over === undefined) {
    context.diagnostics.error("FANOUT_OVER", "fanout.over is required.", `${path}.fanout.over`);
  } else if (Array.isArray(fanout.over)) {
    // Reject arrays containing non-primitive values (objects, nested arrays)
    // since JSON.stringify of objects produces invalid CEL syntax.
    for (let i = 0; i < fanout.over.length; i++) {
      const el = fanout.over[i];
      if (el !== null && el !== undefined && typeof el === "object") {
        context.diagnostics.error("FANOUT_OVER_TYPE", `fanout.over array elements must be primitives (string, number, boolean, null), got ${typeof el} at index ${i}.`, `${path}.fanout.over[${i}]`);
      }
    }
    // Coerce array → JSON string so the IR always stores strings
    fanout.over = JSON.stringify(fanout.over);
  } else if (typeof fanout.over !== "string") {
    context.diagnostics.error("FANOUT_OVER_TYPE", `fanout.over must be an array or CEL expression string, got ${typeof fanout.over === "object" && fanout.over !== null ? "object" : typeof fanout.over}.`, `${path}.fanout.over`);
  }
  validateJoin(fanout.join, ["all", "race", "quorum"], `${path}.fanout.join`, "fanout.join", context);

  if (fanout.join === "quorum" && !isPositiveInteger(fanout.quorum)) {
    context.diagnostics.error("FANOUT_QUORUM", "fanout.quorum must be a positive integer when join is quorum.", `${path}.fanout.quorum`);
  }

  if (fanout.success_criteria !== undefined) {
    if (!isRecord(fanout.success_criteria)) {
      context.diagnostics.error("FANOUT_SUCCESS_CRITERIA", "fanout.success_criteria must be an object.", `${path}.fanout.success_criteria`);
      return;
    }
    if (!isPositiveInteger(fanout.success_criteria.min_success)) {
      context.diagnostics.error("FANOUT_SUCCESS_CRITERIA", "fanout.success_criteria.min_success must be a positive integer.", `${path}.fanout.success_criteria.min_success`);
    }
  }
}

function validateJoin(value: unknown, allowed: string[], path: string, label: string, context: CompileContext): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    context.diagnostics.error("JOIN_VALUE", `${label} must be one of ${allowed.join(", ")}.`, path);
  }
}

function validateCapture(capture: unknown, path: string, context: CompileContext): void {
  if (!isRecord(capture)) {
    context.diagnostics.error("CAPTURE_SHAPE", "run: program capture must be an object when present.", `${path}.capture`);
    return;
  }

  if (!["stdout", "file"].includes(String(capture.from))) {
    context.diagnostics.error("CAPTURE_FROM", "run: program capture.from must be stdout or file.", `${path}.capture.from`);
  }
  if (!["json", "text"].includes(String(capture.parse))) {
    context.diagnostics.error("CAPTURE_PARSE", "run: program capture.parse must be json or text.", `${path}.capture.parse`);
  }
  if (capture.from === "file" && typeof capture.path !== "string") {
    context.diagnostics.error("CAPTURE_PATH", "run: program capture.path must be a string when capture.from is file.", `${path}.capture.path`);
  }
  if (capture.path !== undefined && typeof capture.path !== "string") {
    context.diagnostics.error("CAPTURE_PATH", "run: program capture.path must be a string when present.", `${path}.capture.path`);
  }
}

function validateApprovalStep(approval: Record<string, unknown>, path: string, context: CompileContext): void {
  if (typeof approval.prompt !== "string") {
    context.diagnostics.error("APPROVAL_PROMPT", "approval.prompt must be a string.", `${path}.approval.prompt`);
  }
  if (typeof approval.timeout !== "string") {
    context.diagnostics.error("APPROVAL_TIMEOUT", "approval.timeout must be a duration string.", `${path}.approval.timeout`);
  } else {
    try {
      parseDurationMs(approval.timeout, { strict: true });
    } catch {
      context.diagnostics.error("APPROVAL_TIMEOUT", "approval.timeout must be a valid duration string (e.g. 5m, 2h, 30s).", `${path}.approval.timeout`);
    }
  }
  if (!["fail", "escalate", "approve", "reject"].includes(String(approval.on_timeout))) {
    context.diagnostics.error("APPROVAL_ON_TIMEOUT", "approval.on_timeout must be fail, escalate, approve, or reject.", `${path}.approval.on_timeout`);
  }
}

function validateRetry(retry: unknown, path: string, context: CompileContext): void {
  if (!isRecord(retry)) {
    context.diagnostics.error("RETRY_SHAPE", "retry must be an object when present.", `${path}.retry`);
    return;
  }
  if (!isPositiveInteger(retry.max)) {
    context.diagnostics.error("RETRY_SHAPE", "retry.max must be a positive integer.", `${path}.retry.max`);
  }
  if (retry.backoff !== undefined) {
    if (typeof retry.backoff !== "string") {
      context.diagnostics.error("RETRY_SHAPE", "retry.backoff must be a duration string.", `${path}.retry.backoff`);
    } else {
      try {
        parseDurationMs(retry.backoff, { strict: true });
      } catch {
        context.diagnostics.error("RETRY_SHAPE", "retry.backoff must be a valid duration string.", `${path}.retry.backoff`);
      }
    }
  }
}

function validateStepTimeout(step: Record<string, unknown>, path: string, context: CompileContext): void {
  if (step.timeout === undefined) return;
  if (typeof step.timeout === "number") {
    if (step.timeout <= 0) {
      context.diagnostics.error("STEP_TIMEOUT", "step.timeout number must be positive (milliseconds).", `${path}.timeout`);
    }
    return;
  }
  if (typeof step.timeout === "string") {
    try {
      parseDurationMs(step.timeout, { strict: true });
    } catch {
      context.diagnostics.error("STEP_TIMEOUT", "step.timeout must be a valid duration string or number (ms).", `${path}.timeout`);
    }
    return;
  }
  const typeDesc = step.timeout === null ? "null" : typeof step.timeout;
  context.diagnostics.error("STEP_TIMEOUT", `step.timeout must be a duration string or number (ms), got ${typeDesc}.`, `${path}.timeout`);
}

function validateStepOnError(step: Record<string, unknown>, path: string, context: CompileContext): void {
  if (step.on_error === undefined) return;
  if (typeof step.on_error !== "string") {
    const typeDesc = step.on_error === null ? "null" : typeof step.on_error;
    context.diagnostics.error("STEP_ON_ERROR", `step.on_error must be a string, one of fail, retry, skip, got ${typeDesc}.`, `${path}.on_error`);
    return;
  }
  if (!["fail", "retry", "skip"].includes(step.on_error)) {
    context.diagnostics.error("STEP_ON_ERROR", `step.on_error must be one of fail, retry, skip, got '${step.on_error}'.`, `${path}.on_error`);
  }
}

function validateJsonSchema(schema: unknown, path: string, context: CompileContext): void {
  if (!isRecord(schema)) {
    context.diagnostics.error("JSON_SCHEMA_SHAPE", "Compiled schema must be a JSON Schema object.", path);
    return;
  }
  if (!ajv.validateSchema(schema)) {
    const message = ajv.errorsText(ajv.errors);
    context.diagnostics.error("JSON_SCHEMA_INVALID", `Invalid JSON Schema: ${message}`, path);
  }
}

function collectStepIds(steps: WorkflowStep[], diagnostics: DiagnosticBag): Set<string> {
  const ids = new Set<string>();
  const visit = (items: WorkflowStep[], path: string): void => {
    items.forEach((step, index) => {
      const stepPath = `${path}[${index}]`;
      if (typeof step.id === "string") {
        if (ids.has(step.id)) {
          diagnostics.error("STEP_ID_DUPLICATE", `Duplicate step id '${step.id}'.`, `${stepPath}.id`);
        }
        ids.add(step.id);
      }
      if (Array.isArray(step.parallel)) {
        visit(asPlainSteps(step.parallel), `${stepPath}.parallel`);
      }
      if (isRecord(step.fanout) && Array.isArray(step.fanout.do)) {
        visit(asPlainSteps(step.fanout.do), `${stepPath}.fanout.do`);
      }
      if (isRecord(step.switch) && Array.isArray(step.switch.cases)) {
        step.switch.cases.forEach((caseSpec, caseIndex) => {
          if (isRecord(caseSpec) && Array.isArray(caseSpec.do)) {
            visit(asPlainSteps(caseSpec.do), `${stepPath}.switch.cases[${caseIndex}].do`);
          }
        });
      }
      if (isRecord(step.switch) && isRecord(step.switch.default) && Array.isArray(step.switch.default.do)) {
        visit(asPlainSteps(step.switch.default.do), `${stepPath}.switch.default.do`);
      }
      if (isRecord(step.loop) && Array.isArray(step.loop.do)) {
        visit(asPlainSteps(step.loop.do), `${stepPath}.loop.do`);
      }
    });
  };
  visit(steps, "$.workflow.steps");
  return ids;
}

function keyTemplate(nodePath: string[]): NodeKeyTemplate {
  return {
    astVersion: 1,
    nodePath: nodePath.join("/")
  };
}

function pickMetadata(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

function asSteps(value: unknown[], path: string, context: CompileContext): WorkflowStep[] {
  return value.map((item, index) => {
    if (!isRecord(item)) {
      context.diagnostics.error("STEP_SHAPE", "Step entries must be objects.", `${path}[${index}]`);
      return {};
    }
    return item;
  });
}

function asPlainSteps(value: unknown[]): WorkflowStep[] {
  return value.filter(isRecord);
}

function isWorkflowSpec(value: unknown): value is WorkflowSpec {
  return (
    isRecord(value) &&
    typeof value.version === "number" &&
    typeof value.name === "string" &&
    isRecord(value.workflow) &&
    Array.isArray(value.workflow.steps)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function digest(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function result(ok: boolean, diagnostics: DiagnosticBag): CompileResult {
  return {
    ok,
    diagnostics: diagnostics.diagnostics
  };
}
