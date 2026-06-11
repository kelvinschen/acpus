import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { parse as parseYaml } from "yaml";
import { DiagnosticBag } from "./diagnostics.js";
import { createExpressionCollector } from "./expressions.js";
import { createSchedule } from "./schedule.js";
import { compileSchemaDsl } from "./schema/index.js";
import { parseDurationMs } from "./duration.js";
import { validateWithSchema } from "./schema-validator.js";
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
  validateWithSchema(expanded, diagnostics);
  const { ids: stepIds, kinds: stepKinds } = collectStepIds(expanded.workflow.steps, diagnostics);
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

  const expressionCollector = createExpressionCollector(diagnostics, stepIds, stepKinds);
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
      let includedSource: string;
      try {
        includedSource = options.includeResolver(step.include, options.sourcePath);
      } catch (error) {
        diagnostics.error(
          "INCLUDE_RESOLUTION",
          errorMessage(error),
          `$.workflow.steps[${index}].include`
        );
        continue;
      }
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

  // Semantic checks not covered by JSON Schema
  for (const [agentName, agent] of Object.entries(spec.agents ?? {})) {
    if (!isRecord(agent)) continue;  // Schema handles shape errors
    // AGENT_REF: check that referenced agents actually exist (cross-reference)
    // This is done in validateAgentStep at step level
  }
}

function compileSteps(steps: WorkflowStep[], parentPath: string[], path: string, context: CompileContext): IrNode[] {
  return steps.map((step, index) => compileStep(step, parentPath, `${path}[${index}]`, context));
}

function compileStep(step: WorkflowStep, parentPath: string[], path: string, context: CompileContext): IrNode {
  const id = typeof step.id === "string" && step.id.length > 0 ? step.id : `missing_${parentPath.length}_${path}`;
  // Defensive: Schema already validates id; keep as fallback
  if (typeof step.id !== "string" || step.id.length === 0) {
    context.diagnostics.error("STEP_ID", "Every workflow step must define a non-empty string id.", `${path}.id`);
  }

  const nodePath = [...parentPath, id];
  const base = {
    id,
    nodePath,
    keyTemplate: keyTemplate(nodePath)
  };

  if ((step as Record<string, unknown>).session_key !== undefined && step.run !== "agent") {
    context.diagnostics.error("STEP_SHAPE", "session_key is supported only on run: agent steps.", `${path}.session_key`);
  }

  if (step.run === "agent") {
    validateAgentStep(step, path, context);
    validateStepTimeout(step, path, context);
    const metadata = pickMetadata(step, ["run", "use", "prompt", "session_key", "output", "retry", "timeout", "on_error"]);
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
    return {
      ...base,
      kind: "run.program",
      metadata: pickMetadata(step, ["run", "cmd", "env", "capture", "output", "retry", "timeout", "on_error"])
    };
  }

  if (Array.isArray(step.parallel)) {
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
    return {
      ...base,
      kind: "loop",
      keyTemplate: { ...keyTemplate(nodePath), loopRound: true },
      outputMerge: "last",
      children: Array.isArray(loop.do) ? compileSteps(asSteps(loop.do, `${path}.loop.do`, context), nodePath, `${path}.loop.do`, context) : [],
      metadata: pickMetadata(loop, ["until", "max_iterations"])
    };
  }

  if (isRecord(step.guard)) {
    const guard = step.guard;
    if (guard.when !== undefined) {
      if (typeof guard.when === "boolean") {
        guard.when = String(guard.when);
      } else if (typeof guard.when !== "string") {
        const typeDesc = guard.when === null ? "null" : typeof guard.when;
        context.diagnostics.error("GUARD_WHEN_TYPE", `guard.when must be a boolean or CEL expression string, got ${typeDesc}.`, `${path}.guard.when`);
      }
    }
    return {
      ...base,
      kind: "guard",
      metadata: pickMetadata(guard, ["when", "then", "else", "message"])
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

  // Defensive: Schema already validates step kind; keep as fallback
  context.diagnostics.error("STEP_KIND", "Step must define one of run: agent, run: program, parallel, fanout, switch, loop, guard, approval, subworkflow, or include.", path);
  return {
    ...base,
    kind: "run.program",
    metadata: {}
  };
}

function validateAgentStep(step: WorkflowStep, path: string, context: CompileContext): void {
  // AGENT_REF: cross-reference check (not possible in JSON Schema)
  if (typeof step.use === "string" && !Object.prototype.hasOwnProperty.call(context.agents, step.use)) {
    context.diagnostics.error("AGENT_REF", `run: agent step references unknown agent '${step.use}'.`, `${path}.use`);
  }
  if ((step as Record<string, unknown>).retry !== undefined) {
    validateRetry((step as Record<string, unknown>).retry, path, context);
  }
  if (isRecord(step.output)) {
    // output.schema deprecation check (semantic, not structural)
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
  if (isRecord(step.output)) {
    // output.schema deprecation check (semantic, not structural)
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
  // Reject arrays containing non-primitive values (objects, nested arrays)
  // since JSON.stringify of objects produces invalid CEL syntax.
  // Schema validates that over is string|array; this is a runtime coercion check.
  if (Array.isArray(fanout.over)) {
    for (let i = 0; i < fanout.over.length; i++) {
      const el = fanout.over[i];
      if (el !== null && el !== undefined && typeof el === "object") {
        context.diagnostics.error("FANOUT_OVER_TYPE", `fanout.over array elements must be primitives (string, number, boolean, null), got ${typeof el} at index ${i}.`, `${path}.fanout.over[${i}]`);
      }
    }
    // Coerce array → JSON string so the IR always stores strings
    fanout.over = JSON.stringify(fanout.over);
  }
}

function validateApprovalStep(approval: Record<string, unknown>, path: string, context: CompileContext): void {
  // Duration format validation (not expressible in JSON Schema)
  if (typeof approval.timeout === "string") {
    try {
      parseDurationMs(approval.timeout, { strict: true });
    } catch {
      context.diagnostics.error("APPROVAL_TIMEOUT", "approval.timeout must be a valid duration string (e.g. 5m, 2h, 30s).", `${path}.approval.timeout`);
    }
  }
}

function validateRetry(retry: unknown, path: string, context: CompileContext): void {
  // Duration format validation for backoff (not expressible in JSON Schema)
  if (isRecord(retry) && retry.backoff !== undefined) {
    if (typeof retry.backoff === "string") {
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
  // Duration format validation for string timeouts (not expressible in JSON Schema)
  if (typeof step.timeout === "string") {
    try {
      parseDurationMs(step.timeout, { strict: true });
    } catch {
      context.diagnostics.error("STEP_TIMEOUT", "step.timeout must be a valid duration string or number (ms).", `${path}.timeout`);
    }
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

function inferStepKind(step: Record<string, unknown>): string | undefined {
  if (step.run === "agent") return "run.agent";
  if (step.run === "program") return "run.program";
  if (Array.isArray(step.parallel)) return "parallel";
  if (isRecord(step.fanout)) return "fanout";
  if (isRecord(step.switch)) return "switch";
  if (isRecord(step.loop)) return "loop";
  if (isRecord(step.guard)) return "guard";
  if (isRecord(step.approval)) return "approval";
  if (typeof step.subworkflow === "string") return "subworkflow";
  return undefined;
}

function collectStepIds(steps: WorkflowStep[], diagnostics: DiagnosticBag): { ids: Set<string>; kinds: Map<string, string> } {
  const ids = new Set<string>();
  const kinds = new Map<string, string>();
  const visit = (items: WorkflowStep[], path: string): void => {
    items.forEach((step, index) => {
      const stepPath = `${path}[${index}]`;
      if (typeof step.id === "string") {
        if (ids.has(step.id)) {
          diagnostics.error("STEP_ID_DUPLICATE", `Duplicate step id '${step.id}'.`, `${stepPath}.id`);
        }
        ids.add(step.id);
        const kind = inferStepKind(step as Record<string, unknown>);
        if (kind) {
          kinds.set(step.id, kind);
        }
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
  return { ids, kinds };
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
