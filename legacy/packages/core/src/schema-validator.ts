/**
 * Schema-based structural validation for Acpus workflow specs.
 *
 * Compiles WORKFLOW_SCHEMA with Ajv and maps validation errors to
 * diagnostic codes used by the compiler. This handles:
 * - Unknown fields (additionalProperties: false)
 * - Type / enum / required constraints
 * - if/then cross-field dependencies
 * - oneOf step-kind dispatch
 *
 * Duration format validation and semantic checks (cross-references,
 * DSL compilation) remain in the hand-written compiler code.
 */

import { Ajv, type ErrorObject } from "ajv";
import { WORKFLOW_SCHEMA } from "./workflow-schema.js";
import type { DiagnosticBag } from "./diagnostics.js";

// ── Module-level Ajv singleton ──

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(WORKFLOW_SCHEMA);

// ── Error mapping ──

/**
 * Map Ajv validation errors to compiler diagnostics.
 *
 * Strategy:
 * - `additionalProperties` → SPEC_SHAPE / AGENT_SHAPE / STEP_SHAPE based on path
 * - `required` → specific code based on missingProperty
 * - `enum` / `const` → specific code based on allowedValues context
 * - Step-level oneOf failures: suppress structural oneOf/const errors that are
 *   artifacts of branch-matching; only report STEP_KIND if no specific
 *   property-level error can be extracted.
 * - Sub-oneOf errors (timeout, cmd, fanout.over) are classified individually.
 * - Everything else → SPEC_SHAPE as fallback
 */
export function validateWithSchema(spec: unknown, diagnostics: DiagnosticBag): void {
  if (!validate(spec)) {
    const errors = validate.errors ?? [];
    mapErrors(errors, diagnostics, spec);
  }
}

function mapErrors(errors: ErrorObject[], diagnostics: DiagnosticBag, spec: unknown): void {
  // Identify step-level oneOf failures — these produce many noisy sub-errors
  // because Ajv tries each branch and reports all mismatches.
  const stepOneOfPaths = new Set<string>();
  for (const err of errors) {
    if (err.keyword === "oneOf" && isStepPath(err.instancePath)) {
      stepOneOfPaths.add(err.instancePath);
    }
  }

  // For each step-level oneOf failure, re-validate the step against only its
  // intended branch (inferred from the data's discriminator). This avoids two
  // classes of noise that arise once composite child lists recurse into the
  // step union: (1) cross-branch artifacts (e.g. a `loop` step reported as
  // "missing prompt" because the agent branch also failed), and (2) ancestor
  // cascade (a parent step failing its oneOf only because a descendant step is
  // invalid). Descendant step errors are reported by their own oneOf iteration.
  const reportedStepSubErrors = new Set<string>(); // instancePath of reported sub-errors
  for (const stepPath of stepOneOfPaths) {
    const stepData = navigate(spec, stepPath);
    const branch = inferStepBranch(stepData);

    if (branch) {
      const branchErrors = validateAgainstBranch(branch, stepData);
      // Keep only errors that belong to THIS step. Errors inside a nested child
      // step (under a `do`/`parallel` list) are owned by that child's own oneOf
      // iteration, so drop them here to avoid ancestor cascade.
      const relevant = branchErrors.filter((err) => !isWithinNestedStep(err.instancePath));
      let reportedAny = false;
      for (const err of relevant) {
        const absolutePath = prefixPath(stepPath, err.instancePath);
        const path = toPath(absolutePath);
        const code = classifyError(err, path);
        if (code === "STEP_KIND") continue;
        if (err.keyword === "if") continue;
        if (code === "STEP_SHAPE" && isDirectParallelStepNoiseAtAbsolutePath(err, absolutePath, spec)) continue;
        const dedupeKey = `${absolutePath}|${code}|${err.keyword}|${JSON.stringify(err.params)}`;
        if (reportedStepSubErrors.has(dedupeKey)) continue;
        reportedStepSubErrors.add(dedupeKey);
        diagnostics.error(code, formatMessage(err, code, path), path);
        reportedAny = true;
      }
      // The step itself is well-formed (its only failures were invalid
      // descendants, which report their own diagnostics) → emit nothing.
      if (reportedAny || !relevant.some((err) => err.keyword !== "if")) continue;
    }

    // No intended branch could be inferred (or none of its errors classified) —
    // the step truly has no matching kind.
    diagnostics.error("STEP_KIND", "Step must define one of run: agent, run: program, run: signal, parallel, fanout, if, switch, loop, guard, subworkflow, or include.", toPath(stepPath));
  }

  // Now process all remaining errors (non-step-oneOf sub-errors, and errors
  // not under a step-level oneOf)
  for (const err of errors) {
    // Skip errors that are part of a step-level oneOf group (already handled)
    if (stepOneOfPaths.size > 0 && isSubErrorOf(err.instancePath, stepOneOfPaths)) {
      continue;
    }
    // Skip step-level oneOf errors themselves (already handled above)
    if (err.keyword === "oneOf" && isStepPath(err.instancePath)) {
      continue;
    }

    // Skip "if" keyword errors — these are artifacts of if/then evaluation
    // and the "then" error is what's actually useful (or we handle required
    // errors from the then clause directly).
    if (err.keyword === "if") continue;

    const path = toPath(err.instancePath);
    const code = classifyError(err, path);
    if (code === "STEP_SHAPE" && isDirectParallelStepNoise(err, spec)) continue;
    const message = formatMessage(err, code, path);
    diagnostics.error(code, message, path);
  }
}

// ── Branch inference for step oneOf failures ──

/** Map a step's data discriminator to the `$defs` branch it intended to match. */
function inferStepBranch(stepData: unknown): string | undefined {
  if (typeof stepData !== "object" || stepData === null) return undefined;
  const data = stepData as Record<string, unknown>;
  if (data.run === "agent") return "agentStep";
  if (data.run === "program") return "programStep";
  if (data.run === "signal") return "signalStep";
  if ("pipeline" in data) return "pipelineStep";
  if ("parallel" in data) return "parallelStep";
  if ("fanout" in data) return "fanoutStep";
  if ("if" in data) return "ifStep";
  if ("switch" in data) return "switchStep";
  if ("loop" in data) return "loopStep";
  if ("guard" in data) return "guardStep";
  if ("subworkflow" in data) return "subworkflowStep";
  return undefined;
}

/** Cache of per-branch validators so repeated steps don't recompile. */
const branchValidators = new Map<string, ReturnType<typeof ajv.compile>>();

/** Validate `stepData` against a single step branch and return its errors. */
function validateAgainstBranch(branch: string, stepData: unknown): ErrorObject[] {
  let v = branchValidators.get(branch);
  if (!v) {
    v = ajv.compile({ $ref: `#/$defs/${branch}`, $defs: WORKFLOW_SCHEMA.$defs });
    branchValidators.set(branch, v);
  }
  v(stepData);
  return v.errors ?? [];
}

/** Resolve the JSON value at an Ajv instancePath ("/workflow/steps/0"). */
function navigate(spec: unknown, instancePath: string): unknown {
  const parts = instancePath.split("/").filter(Boolean);
  let cur: unknown = spec;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[decodePointer(part)];
  }
  return cur;
}

function isDirectParallelStepNoise(err: ErrorObject, spec: unknown): boolean {
  if (err.keyword !== "additionalProperties") return false;
  if (!/\/parallel\/\d+$/.test(err.instancePath)) return false;
  const value = navigate(spec, err.instancePath);
  return isParallelBranchMissingDo(value);
}

function isDirectParallelStepNoiseAtAbsolutePath(err: ErrorObject, absolutePath: string, spec: unknown): boolean {
  if (err.keyword !== "additionalProperties") return false;
  if (!/\/parallel\/\d+$/.test(absolutePath)) return false;
  return isParallelBranchMissingDo(navigate(spec, absolutePath));
}

function isParallelBranchMissingDo(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Object.prototype.hasOwnProperty.call(value, "do");
}

/** Decode a JSON Pointer token (~1 → /, ~0 → ~). */
function decodePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Join a step's absolute instancePath with a branch-local instancePath. */
function prefixPath(stepPath: string, localPath: string): string {
  return localPath ? stepPath + localPath : stepPath;
}

/**
 * True when a branch-local instancePath points inside a nested child step (an
 * entry in a `do`, `then`, `else`, or `pipeline` list). Such errors belong to that child step's
 * own oneOf iteration, not the enclosing step.
 */
function isWithinNestedStep(localPath: string): boolean {
  return /\/(do|then|else|pipeline)\/\d+(\/|$)/.test(localPath);
}

// ── Error classification ──

function classifyError(err: ErrorObject, path: string): string {
  switch (err.keyword) {
    case "additionalProperties":
      return classifyAdditionalProperties(err, path);

    case "required": {
      const missing = (err.params as { missingProperty: string }).missingProperty;
      return classifyRequired(missing, path);
    }

    case "enum":
      return classifyEnum(err, path);

    case "const":
      return classifyConst(err, path);

    case "type":
      return classifyType(err, path);

    case "minimum":
    case "exclusiveMinimum":
    case "minItems":
      return classifyMinimum(err, path);

    case "pattern":
      return path.endsWith(".id") ? "STEP_ID_INVALID" : "SPEC_SHAPE";

    default:
      return "SPEC_SHAPE";
  }
}

function classifyAdditionalProperties(err: ErrorObject, path: string): string {
  const ctx = pathContext(path);

  switch (ctx) {
    case "agent":
      return "AGENT_SHAPE";
    case "step":
      return "STEP_SHAPE";
    case "fanout":
      return "STEP_SHAPE";
    case "if":
      return "STEP_SHAPE";
    case "switch-case":
      return "STEP_SHAPE";
    case "switch-spec":
      return "STEP_SHAPE";
    case "guard":
      return "STEP_SHAPE";
    case "capture":
      return "CAPTURE_SHAPE";
    case "retry":
      return "RETRY_SHAPE";
    case "success-criteria":
      return "FANOUT_SUCCESS_CRITERIA";
    case "loop":
      return "STEP_SHAPE";
    case "workflow":
      return "SPEC_SHAPE";
    default:
      return "SPEC_SHAPE";
  }
}

function classifyRequired(missing: string, path: string): string {
  const ctx = pathContext(path);

  switch (missing) {
    case "id":
      return "STEP_ID";
    case "use":
      return "AGENT_SHAPE";
    case "prompt":
      return "AGENT_PROMPT";
    case "over":
      return "FANOUT_OVER";
    case "do":
      return path.includes(".parallel[") ? "PARALLEL_DO" : "FANOUT_DO";
    case "condition":
      return ctx === "if" ? "STEP_SHAPE" : "SPEC_SHAPE";
    case "then":
      return ctx === "if" ? "STEP_SHAPE" : ctx === "guard" ? "GUARD_ACTION" : "SPEC_SHAPE";
    case "pipeline":
      return "STEP_KIND";
    case "quorum":
      return "FANOUT_QUORUM";
    case "cmd":
      return "PROGRAM_CMD";
    case "from":
      return "CAPTURE_FROM";
    case "parse":
      return "CAPTURE_PARSE";
    case "path":
      return "CAPTURE_PATH";
    case "timeout":
      return "STEP_TIMEOUT";
    case "on_timeout":
      return "SIGNAL_ON_TIMEOUT";
    case "default":
      return ctx === "switch-spec" ? "SPEC_SHAPE" : "SIGNAL_DEFAULT";
    case "max_iterations":
      return "LOOP_MAX_ITERATIONS";
    case "when":
      return ctx === "guard" ? "GUARD_WHEN" : "SPEC_SHAPE";
    case "else":
      return ctx === "guard" ? "GUARD_ACTION" : "SPEC_SHAPE";
    case "max":
      return "RETRY_SHAPE";
    case "steps":
      return "SPEC_SHAPE";
    case "version":
    case "name":
    case "workflow":
      return "SPEC_SHAPE";
    default:
      return "SPEC_SHAPE";
  }
}

function classifyEnum(err: ErrorObject, path: string): string {
  const allowedValues = (err.params as { allowedValues: unknown[] }).allowedValues;

  // version enum
  if (allowedValues.length === 1 && allowedValues[0] === 1) {
    return "SPEC_VERSION";
  }

  // agent type enum
  if (setsEqual(allowedValues, ["builtin", "command"])) {
    return "AGENT_SHAPE";
  }

  // on_error enum
  if (setsEqual(allowedValues, ["fail", "retry", "skip"])) {
    return "STEP_ON_ERROR";
  }

  // on_timeout enum
  if (setsEqual(allowedValues, ["fail", "default"])) {
    return "SIGNAL_ON_TIMEOUT";
  }

  // join enum (parallel: all, race)
  if (setsEqual(allowedValues, ["all", "race"])) {
    return "JOIN_VALUE";
  }

  // join enum (fanout: all, race, quorum)
  if (setsEqual(allowedValues, ["all", "race", "quorum"])) {
    return "JOIN_VALUE";
  }

  // capture.from enum
  if (setsEqual(allowedValues, ["stdout", "file"])) {
    return "CAPTURE_FROM";
  }

  // capture.parse enum
  if (setsEqual(allowedValues, ["json", "text"])) {
    return "CAPTURE_PARSE";
  }

  // guard action enum
  if (setsEqual(allowedValues, ["continue", "fail", "complete"])) {
    return "GUARD_ACTION";
  }

  return "SPEC_SHAPE";
}

function classifyConst(err: ErrorObject, _path: string): string {
  // run: "agent" or run: "program" const — these are artifacts of oneOf
  // branch matching and don't represent real user errors by themselves.
  return "STEP_KIND";
}

function classifyType(err: ErrorObject, path: string): string {
  const ctx = pathContext(path);

  // Step id type error
  if (path.endsWith(".id")) {
    return "STEP_ID";
  }

  // on_error type error (e.g. null instead of string)
  if (/\.on_error$/.test(path)) {
    return "STEP_ON_ERROR";
  }

  // timeout type error in step context
  if (/\.timeout$/.test(path) && ctx === "step") {
    return "STEP_TIMEOUT";
  }

  // capture type error (not an object)
  if (/\.capture$/.test(path)) {
    return "CAPTURE_SHAPE";
  }

  // fanout.over type error (not string, not array)
  if (/\.fanout\.over$/.test(path)) {
    return "FANOUT_OVER_TYPE";
  }

  if (/\.if\.condition$/.test(path)) {
    return "STEP_SHAPE";
  }

  if (/\.if\.(then|else)$/.test(path)) {
    return "STEP_SHAPE";
  }

  if (/\.pipeline$/.test(path)) {
    return "STEP_SHAPE";
  }

  if (/\.guard\.when$/.test(path)) {
    return "GUARD_WHEN_TYPE";
  }

  if (/\.guard\.message$/.test(path)) {
    return "GUARD_MESSAGE";
  }

  // Agent type errors
  if (ctx === "agent") {
    return "AGENT_SHAPE";
  }

  // Output type error
  if (path.endsWith(".output")) {
    return "OUTPUT_SHAPE";
  }

  return "SPEC_SHAPE";
}

function classifyMinimum(err: ErrorObject, path: string): string {
  if (/\.if\.(then|else)$/.test(path)) {
    return "STEP_SHAPE";
  }

  // retry.max minimum violation
  if (/\.retry\.max$/.test(path)) {
    return "RETRY_SHAPE";
  }
  // fanout success_criteria min_success minimum violation
  if (/\.success_criteria\.min_success$/.test(path)) {
    return "FANOUT_SUCCESS_CRITERIA";
  }
  // timeout exclusiveMinimum violation (negative number)
  if (/\.timeout$/.test(path)) {
    return "STEP_TIMEOUT";
  }
  return "SPEC_SHAPE";
}

function formatMessage(err: ErrorObject, code: string, path: string): string {
  switch (err.keyword) {
    case "additionalProperties": {
      const additionalProp = (err.params as { additionalProperty: string }).additionalProperty;
      const ctx = pathContext(path);
      if (ctx === "agent") {
        return `Unknown agent property '${additionalProp}'.`;
      }
      if (ctx === "step") {
        return `Unknown step property '${additionalProp}'.`;
      }
      if (ctx === "capture") {
        return `Unknown capture property '${additionalProp}'.`;
      }
      if (ctx === "retry") {
        return `Unknown retry property '${additionalProp}'.`;
      }
      return `Unknown property '${additionalProp}'.`;
    }

    case "required": {
      const missing = (err.params as { missingProperty: string }).missingProperty;
      return formatRequiredMessage(missing, code, path);
    }

    case "enum": {
      const allowed = (err.params as { allowedValues: unknown[] }).allowedValues;
      return `Must be one of ${allowed.join(", ")}.`;
    }

    case "const": {
      const value = (err.params as { allowedValue: unknown }).allowedValue;
      return `Must be ${JSON.stringify(value)}.`;
    }

    case "type": {
      const expected = err.params ? (err.params as { type: string }).type : "unknown";
      return formatTypeMessage(code, path, expected);
    }

    case "minimum":
    case "exclusiveMinimum": {
      return formatMinimumMessage(code, path);
    }

    case "minItems": {
      return formatMinimumMessage(code, path);
    }

    case "pattern": {
      if (code === "STEP_ID_INVALID") return "Author ids must match ^[A-Za-z_][A-Za-z0-9_-]*$ and must not start with '$'.";
      return err.message ?? "Schema validation error.";
    }

    default:
      return err.message ?? "Schema validation error.";
  }
}

function formatRequiredMessage(missing: string, code: string, _path: string): string {
  switch (code) {
    case "SPEC_VERSION":
      return "Only DSL version 1 is supported.";
    case "STEP_ID":
      return "Every workflow step must define a non-empty string id.";
    case "AGENT_SHAPE":
      return "Agent definition (type builtin/command) must define a non-empty use.";
    case "AGENT_PROMPT":
      return "run: agent steps must define a prompt string.";
    case "PROGRAM_CMD":
      return "run: program steps must define cmd as a string or array.";
    case "FANOUT_OVER":
      return "fanout.over is required.";
    case "FANOUT_DO":
      return "fanout.do must be an array of steps.";
    case "PARALLEL_DO":
      return "parallel entries are branch descriptors { id, do }, not direct steps; wrap branch steps under do.";
    case "FANOUT_QUORUM":
      return "fanout.quorum must be a positive integer when join is quorum.";
    case "STEP_SHAPE":
      if (missing === "condition") return "if.condition is required.";
      if (missing === "then") return "if.then must be a non-empty array of steps.";
      return `Missing required property '${missing}'.`;
    case "CAPTURE_FROM":
      return "run: program capture.from must be stdout or file.";
    case "CAPTURE_PARSE":
      return "run: program capture.parse must be json or text.";
    case "CAPTURE_PATH":
      return "run: program capture.path must be a string when capture.from is file.";
    case "SIGNAL_PROMPT":
      return "run: signal steps must define a prompt string.";
    case "SIGNAL_TIMEOUT":
      return "signal.timeout must be a duration string.";
    case "SIGNAL_ON_TIMEOUT":
      return "signal.on_timeout must be fail or default, and is required when timeout is set.";
    case "SIGNAL_DEFAULT":
      return "signal.default is required when on_timeout is default.";
    case "LOOP_MAX_ITERATIONS":
      return "loop.max_iterations must be a number.";
    case "GUARD_WHEN":
      return "guard.when is required.";
    case "GUARD_ACTION":
      return "guard.then and guard.else must be one of continue, fail, or complete.";
    case "RETRY_SHAPE":
      return "retry.max must be a non-negative integer.";
    default:
      return `Missing required property '${missing}'.`;
  }
}

function formatTypeMessage(code: string, path: string, expectedType: string): string {
  switch (code) {
    case "STEP_ON_ERROR":
      return `step.on_error must be a string, one of fail, retry, skip.`;
    case "STEP_TIMEOUT":
      return `step.timeout must be a duration string or number (ms).`;
    case "CAPTURE_SHAPE":
      return `run: program capture must be an object when present.`;
    case "OUTPUT_SHAPE":
      if (path.includes("agent")) {
        return `run: agent output must be an object when present.`;
      }
      return `run: program output must be an object when present.`;
    case "FANOUT_OVER_TYPE":
      return `fanout.over must be an array or CEL expression string.`;
    case "STEP_SHAPE":
      if (/\.if\.condition$/.test(path)) return `if.condition must be a boolean or CEL expression string.`;
      if (/\.if\.then$/.test(path)) return `if.then must be a non-empty array of steps.`;
      if (/\.if\.else$/.test(path)) return `if.else must be a non-empty array of steps when present.`;
      return `Must be of type ${expectedType}.`;
    case "GUARD_WHEN_TYPE":
      return `guard.when must be a boolean or CEL expression string.`;
    case "GUARD_MESSAGE":
      return `guard.message must be a string template.`;
    default:
      return `Must be of type ${expectedType}.`;
  }
}

function formatMinimumMessage(code: string, _path: string): string {
  switch (code) {
    case "STEP_SHAPE":
      if (/\.if\.then$/.test(_path)) return "if.then must be a non-empty array of steps.";
      if (/\.if\.else$/.test(_path)) return "if.else must be a non-empty array of steps when present.";
      return "Value must be a positive integer.";
    case "RETRY_SHAPE":
      return "retry.max must be a non-negative integer.";
    case "FANOUT_SUCCESS_CRITERIA":
      return "fanout.success_criteria.min_success must be a positive integer.";
    case "STEP_TIMEOUT":
      return "step.timeout number must be positive (milliseconds).";
    default:
      return "Value must be a positive integer.";
  }
}

/** Convert Ajv instancePath ("/workflow/steps/0/run") to $-path ("$.workflow.steps[0].run") */
function toPath(instancePath: string): string {
  if (!instancePath) return "$";
  // Split on "/" and convert array indices
  const parts = instancePath.split("/").filter(Boolean);
  let result = "$";
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      result += `[${part}]`;
    } else {
      result += `.${part}`;
    }
  }
  return result;
}

/** Determine the semantic context of a path for error classification. */
function pathContext(path: string): string {
  // Match patterns like $.agents.xxx or $.workflow.steps[n].fanout etc.
  // Note: there is no "signal" context — a `run: signal` step shares the flat
  // `$.workflow.steps[n]` path with agent/program steps, so it resolves to
  // "step". Signal-specific diagnostics are owned by the compiler
  // (validateSignalStep), not the schema-validator.
  if (/\.agents\.[^.]+$/.test(path) || /\.agents\.[^.]+\./.test(path)) {
    return "agent";
  }
  // A step entry itself — top-level `steps[n]` or a nested composite child
  // (`do[n]` / `then[n]` / `else[n]` / `parallel[n]`). Checked before the composite-keyword cases so a
  // nested step entry resolves to "step" rather than its enclosing composite.
  if (/\.(steps|do|then|else|parallel)\[\d+\]$/.test(path)) {
    return "step";
  }
  if (/\.fanout\b/.test(path)) {
    if (/\.fanout\.success_criteria/.test(path)) return "success-criteria";
    return "fanout";
  }
  if (/\.if\b/.test(path)) {
    return "if";
  }
  if (/\.capture\b/.test(path)) {
    return "capture";
  }
  if (/\.retry\b/.test(path)) {
    return "retry";
  }
  if (/\.switch\b/.test(path) && /\.cases\[\d+\]$/.test(path)) {
    return "switch-case";
  }
  if (/\.switch\b/.test(path)) {
    return "switch-spec";
  }
  if (/\.guard\b/.test(path)) {
    return "guard";
  }
  if (/\.loop\b/.test(path)) {
    return "loop";
  }
  if (/\.workflow\b/.test(path)) {
    return "workflow";
  }
  if (/\.steps\[\d+\]/.test(path)) {
    return "step";
  }
  return "top";
}

/** Check if an instancePath looks like a step (an entry in a steps/do/parallel list). */
function isStepPath(instancePath: string): boolean {
  // Steps live directly in `workflow.steps` or nested body lists (`do`,
  // `then`, `else`, or `parallel`). Each is an array whose entries are full
  // Nodes, so a step entry path ends with one of those array names followed by
  // a numeric index.
  return /\/(steps|do|then|else|parallel)\/\d+$/.test(instancePath);
}

/** Check if errPath is a sub-path of any of the given parent paths. */
function isSubErrorOf(errPath: string, parentPaths: Set<string>): boolean {
  for (const parent of parentPaths) {
    if (errPath === parent || errPath.startsWith(parent + "/")) {
      return true;
    }
  }
  return false;
}

/** Set equality check for enum classification. */
function setsEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}
