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
    mapErrors(errors, diagnostics);
  }
}

function mapErrors(errors: ErrorObject[], diagnostics: DiagnosticBag): void {
  // Identify step-level oneOf failures — these produce many noisy sub-errors
  // because Ajv tries each branch and reports all mismatches.
  const stepOneOfPaths = new Set<string>();
  for (const err of errors) {
    if (err.keyword === "oneOf" && isStepPath(err.instancePath)) {
      stepOneOfPaths.add(err.instancePath);
    }
  }

  // For each step-level oneOf failure, try to extract specific property errors
  // from the sub-errors. If we can, report those instead of STEP_KIND.
  const reportedStepSubErrors = new Set<string>(); // instancePath of reported sub-errors
  for (const stepPath of stepOneOfPaths) {
    // Include errors at the step level itself AND deeper sub-errors
    const subErrors = errors.filter(
      (err) => (err.instancePath === stepPath || err.instancePath.startsWith(stepPath + "/")) && err.keyword !== "oneOf"
    );

    // Collect all additionalProperties errors at the step level
    const additionalPropErrors = subErrors.filter(
      (err) => err.keyword === "additionalProperties" && err.instancePath === stepPath
    );

    // If there are additionalProperties errors, find the "intended branch" and
    // report only the truly unknown properties from it.
    if (additionalPropErrors.length > 0) {
      // Group additionalProperties by the property name and count how many
      // branches reject each property.
      const propRejectionCounts = new Map<string, number>();
      for (const err of additionalPropErrors) {
        const prop = (err.params as { additionalProperty: string }).additionalProperty;
        propRejectionCounts.set(prop, (propRejectionCounts.get(prop) ?? 0) + 1);
      }

      // Properties rejected by ALL branches are truly unknown in every context.
      // Properties rejected by only SOME branches are actually known in the
      // matching branch — the truly unknown ones are those rejected even by
      // the branch that the user clearly intended.
      // Heuristic: properties present in the data that are rejected by all branches
      // are the truly unknown ones. We count how many branches there are from
      // the total additionalProperties errors.
      // Derive branch count from the schema so adding a new step kind
      // doesn't require updating a magic number here.
      const stepDef = (WORKFLOW_SCHEMA.$defs as Record<string, Record<string, unknown>>).step;
      const branchCount = (stepDef.oneOf as unknown[]).length;
      const trulyUnknown = [...propRejectionCounts.entries()]
        .filter(([, count]) => count === branchCount) // rejected by ALL branches
        .map(([prop]) => prop);

      for (const prop of trulyUnknown) {
        const key = `${stepPath}/additionalProperty/${prop}`;
        if (!reportedStepSubErrors.has(key)) {
          reportedStepSubErrors.add(key);
          const path = toPath(stepPath);
          diagnostics.error("STEP_SHAPE", `Unknown step property '${prop}'.`, path);
        }
      }

      // If we found truly unknown properties, we're done for this step
      if (trulyUnknown.length > 0) {
        continue;
      }
    }

    // Try to find classifiable sub-errors that represent real issues
    // (not just structural mismatches from branch selection).
    // Collect all classifiable sub-errors, deduplicated by instancePath,
    // keeping the most specific classification per path.
    const classifiableMap = new Map<string, { err: ErrorObject; code: string; path: string; message: string; specificity: number }>();
    for (const sub of subErrors) {
      const path = toPath(sub.instancePath);
      const code = classifyError(sub, path);
      // Structural artifacts from oneOf branch matching — skip these
      if (code === "STEP_KIND") continue;
      // "if" keyword artifacts — skip
      if (sub.keyword === "if") continue;
      // Skip additionalProperties from non-matching branches (handled above)
      if (sub.keyword === "additionalProperties" && sub.instancePath === stepPath) continue;
      const message = formatMessage(sub, code, path);
      // Specificity: prefer more specific codes over SPEC_SHAPE
      const specificity = codeSpecificity(code);
      const existing = classifiableMap.get(sub.instancePath);
      if (!existing || specificity > existing.specificity) {
        classifiableMap.set(sub.instancePath, { err: sub, code, path, message, specificity });
      }
    }

    if (classifiableMap.size > 0) {
      // Report the most specific property errors instead of a vague STEP_KIND
      for (const item of classifiableMap.values()) {
        if (!reportedStepSubErrors.has(item.err.instancePath)) {
          reportedStepSubErrors.add(item.err.instancePath);
          diagnostics.error(item.code, item.message, item.path);
        }
      }
    } else {
      // No classifiable sub-error — step truly has no matching kind
      diagnostics.error("STEP_KIND", "Step must define one of run: agent, run: program, parallel, fanout, switch, loop, approval, subworkflow, or include.", toPath(stepPath));
    }
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
    const message = formatMessage(err, code, path);
    diagnostics.error(code, message, path);
  }
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
      return classifyMinimum(err, path);

    case "dependencies":
    case "dependentRequired":
      // approval gate: `timeout` present requires `on_timeout`.
      return pathContext(path) === "approval" ? "APPROVAL_ON_TIMEOUT" : "SPEC_SHAPE";

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
    case "switch-case":
      return "STEP_SHAPE";
    case "switch-spec":
      return "STEP_SHAPE";
    case "approval":
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
      // Map to AGENT_SHAPE for backward compatibility with existing tests
      if (ctx === "agent") return "AGENT_SHAPE";
      return "AGENT_SHAPE";
    case "prompt":
      if (ctx === "approval") return "APPROVAL_PROMPT";
      return "AGENT_PROMPT";
    case "over":
      return "FANOUT_OVER";
    case "do":
      return "FANOUT_DO";
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
      if (ctx === "approval") return "APPROVAL_TIMEOUT";
      return "STEP_TIMEOUT";
    case "on_timeout":
      return "APPROVAL_ON_TIMEOUT";
    case "max_iterations":
      return "LOOP_MAX_ITERATIONS";
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
  if (setsEqual(allowedValues, ["fail", "escalate", "approve", "reject"])) {
    return "APPROVAL_ON_TIMEOUT";
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
    case "FANOUT_QUORUM":
      return "fanout.quorum must be a positive integer when join is quorum.";
    case "CAPTURE_FROM":
      return "run: program capture.from must be stdout or file.";
    case "CAPTURE_PARSE":
      return "run: program capture.parse must be json or text.";
    case "CAPTURE_PATH":
      return "run: program capture.path must be a string when capture.from is file.";
    case "APPROVAL_PROMPT":
      return "approval.prompt must be a string.";
    case "APPROVAL_TIMEOUT":
      return "approval.timeout must be a duration string.";
    case "APPROVAL_ON_TIMEOUT":
      return "approval.on_timeout must be fail, escalate, approve, or reject.";
    case "LOOP_MAX_ITERATIONS":
      return "loop.max_iterations must be a number.";
    case "RETRY_SHAPE":
      return "retry.max must be a positive integer.";
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
    default:
      return `Must be of type ${expectedType}.`;
  }
}

function formatMinimumMessage(code: string, _path: string): string {
  switch (code) {
    case "RETRY_SHAPE":
      return "retry.max must be a positive integer.";
    case "FANOUT_SUCCESS_CRITERIA":
      return "fanout.success_criteria.min_success must be a positive integer.";
    case "STEP_TIMEOUT":
      return "step.timeout number must be positive (milliseconds).";
    default:
      return "Value must be a positive integer.";
  }
}

// ── Path utilities ──

/** Higher specificity = more precise code. SPEC_SHAPE is the most generic. */
function codeSpecificity(code: string): number {
  if (code === "SPEC_SHAPE") return 0;
  if (code === "STEP_SHAPE" || code === "AGENT_SHAPE") return 1;
  return 2; // All specific codes (STEP_TIMEOUT, STEP_ON_ERROR, etc.)
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
  if (/\.agents\.[^.]+$/.test(path) || /\.agents\.[^.]+\./.test(path)) {
    return "agent";
  }
  if (/\.fanout\b/.test(path)) {
    if (/\.fanout\.success_criteria/.test(path)) return "success-criteria";
    return "fanout";
  }
  if (/\.approval\b/.test(path)) {
    return "approval";
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

/** Check if an instancePath looks like a step (direct child of steps array). */
function isStepPath(instancePath: string): boolean {
  // /workflow/steps/N — exactly one index deep under steps
  const match = instancePath.match(/^\/workflow\/steps\/\d+$/);
  return match !== null;
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
