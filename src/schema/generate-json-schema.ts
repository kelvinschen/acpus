import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WorkflowSpecSchema } from "./workflow-spec.js";

const schema = preferOneOfForStageUnions(removeDefaultedRequiredProperties(z.toJSONSchema(WorkflowSpecSchema, {
  target: "draft-2020-12"
})));

const outPath = path.resolve(process.cwd(), "schemas", "workflow-spec.schema.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
console.log(outPath);

function removeDefaultedRequiredProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeDefaultedRequiredProperties);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const properties = isRecord(record.properties) ? record.properties : undefined;
  const required = Array.isArray(record.required) ? record.required : undefined;
  const defaultedProperties = new Set(Object.entries(properties ?? {})
    .filter(([, propertySchema]) => isRecord(propertySchema) && Object.hasOwn(propertySchema, "default"))
    .map(([key]) => key));
  const entries: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(record)) {
    if (key === "required" && required) {
      const next = required.filter((item) => typeof item !== "string" || !defaultedProperties.has(item));
      if (next.length > 0) entries.push([key, next]);
      continue;
    }
    entries.push([key, removeDefaultedRequiredProperties(entry)]);
  }
  return Object.fromEntries(entries);
}

function preferOneOfForStageUnions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(preferOneOfForStageUnions);
  if (!isRecord(value)) return value;
  const next = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, preferOneOfForStageUnions(entry)]));
  const anyOf = Array.isArray(next.anyOf) ? next.anyOf : undefined;
  if (anyOf && anyOf.length > 0 && anyOf.every((entry) => schemaContainsKindConst(entry))) {
    delete next.anyOf;
    next.oneOf = anyOf;
  }
  return next;
}

function schemaContainsKindConst(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const properties = isRecord(value.properties) ? value.properties : undefined;
  const kind = properties && isRecord(properties.kind) ? properties.kind : undefined;
  if (typeof kind?.const === "string") return true;
  return (Array.isArray(value.oneOf) && value.oneOf.some(schemaContainsKindConst))
    || (Array.isArray(value.anyOf) && value.anyOf.some(schemaContainsKindConst));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
