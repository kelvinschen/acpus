import type { SchemaIR } from "@acpus/core/ir";

export function compactSchemaSummary(schema: SchemaIR): string {
  const normalized = schemaSummary(schema).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= 160 ? normalized : `${characters.slice(0, 159).join("")}…`;
}

function schemaSummary(schema: SchemaIR): string {
  if (schema.kind === "array") return `${schemaSummary(schema.item)}[]`;
  if (schema.kind === "union") return schema.variants.map(schemaSummary).join(" | ");
  if (schema.kind === "literal") return JSON.stringify(schema.value);
  if (schema.kind === "enum") return schema.values.map(value => JSON.stringify(value)).join(" | ");
  if (schema.kind === "record") return `record<${schemaSummary(schema.value)}>`;
  if (schema.kind !== "object") return schema.kind;
  const required = new Set(schema.required);
  return `{ ${Object.entries(schema.fields).map(([name, field]) => `${name}: ${schemaSummary(field)}${required.has(name) ? "" : "?"}`).join(", ")} }`;
}
