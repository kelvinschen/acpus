import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WorkflowSpecSchema } from "./workflow-spec.js";

const schema = removeDefaultedRequiredProperties(z.toJSONSchema(WorkflowSpecSchema, {
  target: "draft-2020-12"
}));

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
