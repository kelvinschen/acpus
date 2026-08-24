import { isJsonValue } from "@acpus/expression/ir";
import type {
  ProjectWorkflowCatalogEntry,
  WorkflowContext,
  WorkflowFiles,
  WorkflowVisualizationResult,
  WorkflowVisualizationSource,
} from "../../api-types.js";
import { isWebGraph } from "./graph-decoder.js";
import { decodeField, requestJson } from "./transport.js";
import {
  hasOnlyKeys,
  isFiniteNumber,
  isOptionalBoolean,
  isOptionalString,
  isRecord,
  isStringArray,
} from "./wire.js";

export async function listWorkflowCatalog(): Promise<ProjectWorkflowCatalogEntry[]> {
  return requestJson("/api/workflows/catalog", undefined, decodeField("catalog", isWorkflowCatalog));
}

export async function listWorkflowFiles(dir = ""): Promise<WorkflowFiles> {
  return requestJson(
    `/api/workflows/files?dir=${encodeURIComponent(dir)}`,
    undefined,
    decodeField("files", isWorkflowFiles),
  );
}

export async function visualizeWorkflow(source: WorkflowVisualizationSource): Promise<WorkflowVisualizationResult> {
  return requestJson("/api/workflows/visualize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  }, decodeField("result", isWorkflowVisualizationResult));
}

function isWorkflowCatalog(value: unknown): value is ProjectWorkflowCatalogEntry[] {
  return Array.isArray(value) && value.every(entry => isRecord(entry)
    && typeof entry.name === "string"
    && typeof entry.entryPath === "string");
}

function isWorkflowFiles(value: unknown): value is WorkflowFiles {
  return isRecord(value)
    && typeof value.dir === "string"
    && Array.isArray(value.entries)
    && value.entries.every(entry => isRecord(entry)
      && typeof entry.name === "string"
      && typeof entry.path === "string"
      && (entry.kind === "directory" || entry.kind === "workflow"));
}

function isWorkflowVisualizationResult(value: unknown): value is WorkflowVisualizationResult {
  if (!isRecord(value)) return false;
  if (value.status === "failed") {
    return isWorkflowPreparationPhase(value.phase) && typeof value.message === "string";
  }
  return value.status === "ready"
    && isWebGraph(value.graph)
    && isRecord(value.workflow)
    && hasOnlyKeys(value.workflow, ["name", "description", "agents", "irVersion", "nodeCount"])
    && typeof value.workflow.name === "string"
    && isOptionalString(value.workflow.description)
    && isAgentDeclarations(value.workflow.agents)
    && isFiniteNumber(value.workflow.irVersion)
    && isFiniteNumber(value.workflow.nodeCount)
    && isWorkflowContract(value.contract)
    && typeof value.sourceGraphDigest === "string";
}

export function isWorkflowContext(value: unknown): value is WorkflowContext {
  return isRecord(value)
    && hasOnlyKeys(value, ["name", "description", "agents"])
    && typeof value.name === "string"
    && isOptionalString(value.description)
    && isAgentDefinitions(value.agents);
}

function isAgentDefinitions(value: unknown): value is WorkflowContext["agents"] {
  return isRecord(value) && Object.values(value).every(isAgentDefinition);
}

function isAgentDeclarations(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(value => isAgentDefinition(value) || isAgentSlot(value));
}

function isAgentDefinition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const common = isOptionalString(value.model)
    && (value.config === undefined || isStringRecord(value.config))
    && (value.permissionMode === undefined
      || value.permissionMode === "approve-reads"
      || value.permissionMode === "approve-all"
      || value.permissionMode === "deny-all")
    && isOptionalString(value.cwd)
    && (value.env === undefined || isStringRecord(value.env));
  if (!common) return false;
  if (value.kind === "agent_definition") {
    return hasOnlyKeys(value, ["kind", "use", "model", "config", "permissionMode", "cwd", "env"])
      && typeof value.use === "string";
  }
  return value.kind === "agent_command"
    && hasOnlyKeys(value, ["kind", "command", "model", "config", "permissionMode", "cwd", "env"])
    && typeof value.command === "string";
}

function isAgentSlot(value: unknown): boolean {
  return isRecord(value)
    && value.kind === "agent_slot"
    && hasOnlyKeys(value, ["kind", "model", "config", "permissionMode", "cwd", "env"])
    && isOptionalString(value.model)
    && (value.config === undefined || isStringRecord(value.config))
    && (value.permissionMode === undefined
      || value.permissionMode === "approve-reads"
      || value.permissionMode === "approve-all"
      || value.permissionMode === "deny-all")
    && isOptionalString(value.cwd)
    && (value.env === undefined || isStringRecord(value.env));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === "string");
}

function isWorkflowPreparationPhase(value: unknown): boolean {
  return value === "source"
    || value === "check"
    || value === "compile"
    || value === "lock"
    || value === "validate";
}

function isWorkflowContract(value: unknown): boolean {
  return isRecord(value)
    && isExprIr(value.output)
    && (value.inputSchema === undefined || isSchemaIr(value.inputSchema))
    && isStaticExprShape(value.outputShape);
}

function isExprIr(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "literal":
      return isJsonPrimitive(value.value);
    case "ref":
      return isStringArray(value.path);
    case "call":
      return typeof value.fn === "string"
        && Array.isArray(value.args)
        && value.args.every(isExprIr);
    case "array":
      return Array.isArray(value.items) && value.items.every(isExprIr);
    case "object":
      return isRecord(value.fields) && Object.values(value.fields).every(isExprIr);
    case "template":
      return Array.isArray(value.parts) && value.parts.every(part => isRecord(part)
        && (part.kind === "text"
          ? typeof part.value === "string"
          : part.kind === "expr" && isExprIr(part.expr)));
    default:
      return false;
  }
}

function isSchemaIr(value: unknown): boolean {
  if (!isRecord(value)
    || typeof value.kind !== "string"
    || !isOptionalString(value.description)
    || (value.default !== undefined && !isJsonValue(value.default))
    || !isOptionalBoolean(value.optional)
    || !isOptionalBoolean(value.nullable)) {
    return false;
  }
  switch (value.kind) {
    case "unknown":
    case "string":
    case "number":
    case "boolean":
    case "null":
      return true;
    case "array":
      return isSchemaIr(value.item);
    case "object":
      return isRecord(value.fields)
        && Object.values(value.fields).every(isSchemaIr)
        && isStringArray(value.required)
        && typeof value.additionalProperties === "boolean";
    case "record":
      return isSchemaIr(value.value);
    case "union":
      return Array.isArray(value.variants) && value.variants.every(isSchemaIr);
    case "literal":
      return isJsonPrimitive(value.value);
    case "enum":
      return Array.isArray(value.values) && value.values.every(isJsonPrimitive);
    default:
      return false;
  }
}

function isStaticExprShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "object") return isStringArray(value.possibleKeys);
  return value.kind === "array" || value.kind === "scalar" || value.kind === "dynamic";
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || isFiniteNumber(value);
}
