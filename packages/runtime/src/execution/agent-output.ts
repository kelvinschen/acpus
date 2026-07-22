import { isDeepStrictEqual } from "node:util";
import { schemaToJsonSchema } from "@acpus/core/schema";
import type { SchemaIR } from "@acpus/core/ir";
import { isJsonValue, type JsonValue } from "@acpus/expression/ir";
import { jsonrepair } from "jsonrepair";
import { err, ok, type Result } from "neverthrow";
import { tryNormalizeValue } from "../evaluation/schema.js";

const OUTPUT_OPEN = "<ACPUS_OUTPUT>";
const OUTPUT_CLOSE = "</ACPUS_OUTPUT>";

type AgentOutputFailurePhase = "framing" | "json" | "schema";
type AgentOutputParsing = "direct" | "repaired";

type PayloadParsing =
  | { ok: true; value: JsonValue; parsing: AgentOutputParsing }
  | { ok: false; phase: "framing" | "json" };

export type AgentOutputProcessing =
  | { outcome: "accepted"; parsing: AgentOutputParsing; projectionChanged: boolean }
  | { outcome: "rejected"; phase: "framing" | "json" }
  | { outcome: "rejected"; phase: "schema"; parsing: AgentOutputParsing; projectionChanged: boolean };

type AgentOutputAccepted = { output: JsonValue; outputProcessing: AgentOutputProcessing };
type AgentOutputFailure = {
  kind: "output_framing" | "output_json" | "output_conformance";
  phase: AgentOutputFailurePhase;
  message: string;
  outputProcessing: AgentOutputProcessing;
};

export function buildAgentOutputPrompt(text: string, schema: SchemaIR): string {
  return `${text}\n\n${outputContract(schema)}`;
}

export function buildAgentOutputRepairPrompt(schema: SchemaIR, phase: AgentOutputFailurePhase): string {
  const reason = {
    framing: "The previous response did not contain exactly one unambiguous terminal ACPUS_OUTPUT frame.",
    json: "The previous ACPUS_OUTPUT payload did not contain exactly one valid JSON value.",
    schema: "The previous ACPUS_OUTPUT payload did not conform to the required schema.",
  }[phase];
  return `# OUTPUT REPAIR\n${reason}\nReturn the complete corrected frame now. Do not repeat the task or explain the correction.\n\n${outputContract(schema)}`;
}

export function conformAgentOutput(schema: SchemaIR, text: string, nodeId: string): Result<AgentOutputAccepted, AgentOutputFailure> {
  const payload = framedPayload(text);
  if (payload === undefined) return err({
    kind: "output_framing",
    phase: "framing",
    message: `Agent node '${nodeId}' response did not contain one complete terminal ${OUTPUT_OPEN} frame.`,
    outputProcessing: { outcome: "rejected", phase: "framing" },
  });

  const parsed = parsePayload(payload);
  if (!parsed.ok) return err({
    kind: parsed.phase === "framing" ? "output_framing" : "output_json",
    phase: parsed.phase,
    message: parsed.phase === "framing"
      ? `Agent node '${nodeId}' response contained ambiguous ACPUS_OUTPUT framing.`
      : `Agent node '${nodeId}' ACPUS_OUTPUT payload is not one valid JSON value.`,
    outputProcessing: { outcome: "rejected", phase: parsed.phase },
  });

  const projected = projectToSchema(schema, parsed.value);
  const projectionChanged = !isDeepStrictEqual(parsed.value, projected);
  const normalized = tryNormalizeValue(schema, projected, `Node '${nodeId}' output`);
  return normalized.isOk()
    ? ok({
        output: normalized.value,
        outputProcessing: { outcome: "accepted", parsing: parsed.parsing, projectionChanged },
      })
    : err({
        kind: "output_conformance",
        phase: "schema",
        message: normalized.error.message,
        outputProcessing: { outcome: "rejected", phase: "schema", parsing: parsed.parsing, projectionChanged },
      });
}

function outputContract(schema: SchemaIR): string {
  return `# OUTPUT [MANDATORY]
End your response with exactly one JSON value matching the JSON Schema below, **wrapped in ${OUTPUT_OPEN}...${OUTPUT_CLOSE}**.

JSON Schema:
${JSON.stringify(schemaToJsonSchema(schema), null, 2)}`;
}

function framedPayload(text: string): string | undefined {
  const terminal = text.trimEnd();
  if (!terminal.endsWith(OUTPUT_CLOSE)) return undefined;
  const closeStart = terminal.length - OUTPUT_CLOSE.length;
  const openStart = terminal.indexOf(OUTPUT_OPEN);
  if (openStart < 0 || openStart + OUTPUT_OPEN.length > closeStart) return undefined;
  if (terminal.slice(0, openStart).includes(OUTPUT_CLOSE)) return undefined;
  return terminal.slice(openStart + OUTPUT_OPEN.length, closeStart);
}

function parsePayload(payload: string): PayloadParsing {
  try {
    const value: unknown = JSON.parse(payload);
    return isJsonValue(value) ? { ok: true, value, parsing: "direct" } : { ok: false, phase: "json" };
  } catch {}
  if (payload.includes(OUTPUT_OPEN) || payload.includes(OUTPUT_CLOSE)) return { ok: false, phase: "framing" };
  try {
    const fenced = payload.match(/^[\t\n\r ]*```(?:[A-Za-z_$][\w$]*)?[\t ]*(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)```[\t\n\r ]*$/);
    const repairInput = fenced?.[1] ?? payload;
    if (!isRepairablePayload(repairInput)) return { ok: false, phase: "json" };
    // The allowlist and wrapper keep jsonrepair bounded to one top-level repair candidate.
    const repaired: unknown = JSON.parse(jsonrepair(`[${repairInput}]`));
    if (!Array.isArray(repaired) || repaired.length !== 1 || !isJsonValue(repaired[0])) return { ok: false, phase: "json" };
    return { ok: true, value: repaired[0], parsing: "repaired" };
  } catch {
    return { ok: false, phase: "json" };
  }
}

function isRepairablePayload(text: string): boolean {
  const source = text.trim();
  if (source.length === 0) return false;
  const first = source[0]!;
  if (first === "{" || first === "[") return true;

  let endQuotes: string | undefined;
  if (first === "\"" || first === "'") endQuotes = first;
  else if ("`´‘’".includes(first)) endQuotes = "'`´‘’";
  else if ("“”".includes(first)) endQuotes = "\"“”";
  if (endQuotes) {
    let escaped = false;
    for (let index = 1; index < source.length; index += 1) {
      if (escaped) escaped = false;
      else if (source[index] === "\\") escaped = true;
      else if (endQuotes.includes(source[index]!)) return !hasExtraScalarContent(source.slice(index + 1));
    }
    return true;
  }

  if (/^[-\d]/.test(source)) {
    return /^-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?,?$/.test(source);
  }
  return /^[A-Za-z_$][A-Za-z0-9_$]*,?$/.test(source);
}

function hasExtraScalarContent(text: string): boolean {
  const trailing = text.trim();
  return trailing.length > 0 && trailing !== ",";
}

function projectToSchema(schema: SchemaIR, value: JsonValue): JsonValue {
  if (value === null) return value;
  if (schema.kind === "array" && Array.isArray(value)) return value.map(item => projectToSchema(schema.item, item));
  if (schema.kind === "record" && isJsonObject(value)) {
    const projected = jsonObject();
    for (const [key, item] of Object.entries(value)) setJsonProperty(projected, key, projectToSchema(schema.value, item));
    return projected;
  }
  if (schema.kind === "union") {
    for (const variant of schema.variants) {
      const projected = projectToSchema(variant, value);
      if (tryNormalizeValue(variant, projected, "Agent union variant").isOk()) return projected;
    }
    return value;
  }
  if (schema.kind !== "object" || !isJsonObject(value)) return value;
  const projected = jsonObject();
  if (schema.additionalProperties) {
    for (const [key, item] of Object.entries(value)) setJsonProperty(projected, key, item);
  }
  for (const [key, field] of Object.entries(schema.fields)) {
    if (Object.hasOwn(value, key)) setJsonProperty(projected, key, projectToSchema(field, value[key]!));
  }
  return projected;
}

function jsonObject(): Record<string, JsonValue> {
  return {};
}

function setJsonProperty(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
