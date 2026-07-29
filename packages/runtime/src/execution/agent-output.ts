import { isDeepStrictEqual } from "node:util";
import type { SchemaIR } from "@acpus/core/ir";
import { isJsonValue, type JsonValue } from "@acpus/expression/ir";
import { jsonrepair } from "jsonrepair";
import { err, ok, type Result } from "neverthrow";
import { tryNormalizeValue } from "../evaluation/schema.js";

const OUTPUT_OPEN = "<ACPUS_OUTPUT>";
const OUTPUT_CLOSE = "</ACPUS_OUTPUT>";
const OUTPUT_ESCAPED_CLOSE = "<\\/ACPUS_OUTPUT>";
const TYPE_SCRIPT_IDENTIFIER = /^[$_\p{ID_Start}][$\u200C\u200D_\p{ID_Continue}]*$/u;

type AgentOutputFailurePhase = "framing" | "json" | "schema";
type AgentOutputParsing = "direct" | "repaired";

type PayloadParsing =
  | { ok: true; value: JsonValue; parsing: AgentOutputParsing }
  | { ok: false; phase: "framing" | "json" };

type FramedPayload = { payload: string; parsing: AgentOutputParsing };

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
  const framed = framedPayload(text);
  if (framed === undefined) return err({
    kind: "output_framing",
    phase: "framing",
    message: `Agent node '${nodeId}' response did not contain one complete terminal ${OUTPUT_OPEN} frame.`,
    outputProcessing: { outcome: "rejected", phase: "framing" },
  });

  const parsed = parsePayload(schema, framed.payload);
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
  const parsing = framed.parsing === "repaired" ? "repaired" : parsed.parsing;
  return normalized.isOk()
    ? ok({
        output: normalized.value,
        outputProcessing: { outcome: "accepted", parsing, projectionChanged },
      })
    : err({
        kind: "output_conformance",
        phase: "schema",
        message: normalized.error.message,
        outputProcessing: { outcome: "rejected", phase: "schema", parsing, projectionChanged },
      });
}

function outputContract(schema: SchemaIR): string {
  return `# RESULT HANDOFF [MANDATORY]
Replace the type shape inside the tags with one matching JSON value; comments are guidance. Keep the tags verbatim, do not escape them, and end at the closing tag.
${OUTPUT_OPEN}
${renderResultShape(schema)}
${OUTPUT_CLOSE}`;
}

function renderResultShape(schema: SchemaIR, indentation = ""): string {
  let shape: string;
  switch (schema.kind) {
    case "unknown": shape = "unknown"; break;
    case "string": shape = "string"; break;
    case "number": shape = "number"; break;
    case "boolean": shape = "boolean"; break;
    case "null": shape = "null"; break;
    case "literal": shape = renderJsonLiteral(schema.value); break;
    case "enum": shape = schema.values.map(renderJsonLiteral).join(" | "); break;
    case "array": {
      const item = renderResultShape(schema.item, indentation);
      shape = `${schema.item.kind === "union" || schema.item.nullable ? `(${item})` : item}[]`;
      break;
    }
    case "record": shape = `{ [key: string]: ${renderResultShape(schema.value, indentation)} }`; break;
    case "union": shape = schema.variants.map(variant => renderResultShape(variant, indentation)).join(" | "); break;
    case "object": shape = renderObjectShape(schema.fields, schema.required, schema.additionalProperties, indentation); break;
  }
  if (schema.nullable && schema.kind !== "null") shape = `${shape} | null`;
  const description = schema.description?.replace(/\*\//gu, "* /").replace(/\s+/gu, " ").trim();
  return description ? `${shape} /* ${description} */` : shape;
}

function renderObjectShape(
  fields: Record<string, SchemaIR>,
  required: string[],
  additionalProperties: boolean,
  indentation: string,
): string {
  const properties = [
    ...Object.entries(fields).map(([key, value]) => `${renderPropertyName(key)}${required.includes(key) ? "" : "?"}: ${renderResultShape(value, `${indentation}  `)}`),
    ...(additionalProperties ? ["[key: string]: unknown"] : []),
  ];
  if (properties.length === 0) return "{}";
  const compact = `{ ${properties.join(", ")} }`;
  if (!properties.some(property => property.includes("\n")) && compact.length <= 100) return compact;
  const nestedIndentation = `${indentation}  `;
  return `{\n${nestedIndentation}${properties.join(`,\n${nestedIndentation}`)}\n${indentation}}`;
}

function renderPropertyName(key: string): string {
  return TYPE_SCRIPT_IDENTIFIER.test(key) ? key : renderJsonLiteral(key);
}

function renderJsonLiteral(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (rendered === undefined) throw new Error("SchemaIR literal must be JSON-serializable");
  return rendered;
}

function framedPayload(text: string): FramedPayload | undefined {
  const terminal = text.trimEnd();
  const closing = terminal.endsWith(OUTPUT_CLOSE)
    ? { marker: OUTPUT_CLOSE, parsing: "direct" as const }
    : terminal.endsWith(OUTPUT_ESCAPED_CLOSE)
      ? { marker: OUTPUT_ESCAPED_CLOSE, parsing: "repaired" as const }
      : undefined;
  if (closing === undefined) return undefined;
  const closeStart = terminal.length - closing.marker.length;
  const openStart = terminal.indexOf(OUTPUT_OPEN);
  if (openStart < 0 || openStart + OUTPUT_OPEN.length > closeStart) return undefined;
  const prefix = terminal.slice(0, openStart);
  if (prefix.includes(OUTPUT_CLOSE) || prefix.includes(OUTPUT_ESCAPED_CLOSE)) return undefined;
  return { payload: terminal.slice(openStart + OUTPUT_OPEN.length, closeStart), parsing: closing.parsing };
}

function parsePayload(schema: SchemaIR, payload: string): PayloadParsing {
  try {
    const value: unknown = JSON.parse(payload);
    return isJsonValue(value) ? { ok: true, value, parsing: "direct" } : { ok: false, phase: "json" };
  } catch {}
  if (payload.includes(OUTPUT_OPEN) || payload.includes(OUTPUT_CLOSE) || payload.includes(OUTPUT_ESCAPED_CLOSE)) return { ok: false, phase: "framing" };
  const danglingQuote = parseDanglingTerminalQuote(schema, payload);
  if (danglingQuote !== undefined) return { ok: true, value: danglingQuote, parsing: "repaired" };
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

function parseDanglingTerminalQuote(schema: SchemaIR, payload: string): JsonValue | undefined {
  const terminal = payload.trimEnd();
  if (!terminal.endsWith("\"") || terminal.length < 2 || /\s/u.test(terminal.at(-2)!)) return undefined;
  try {
    const value: unknown = JSON.parse(terminal.slice(0, -1));
    if (!isJsonValue(value)) return undefined;
    const projected = projectToSchema(schema, value);
    return tryNormalizeValue(schema, projected, "Agent output").isOk() ? value : undefined;
  } catch {
    return undefined;
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
