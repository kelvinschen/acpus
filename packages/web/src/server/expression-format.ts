import type { ExprIR, JsonPrimitive, TemplateIR } from "@acpus/expression/ir";

export function renderExpr(expr: ExprIR): string {
  switch (expr.kind) {
    case "literal":
      return renderLiteral(expr.value);
    case "ref":
      return expr.path.join(".");
    case "array":
      return `[${expr.items.map(renderExpr).join(", ")}]`;
    case "object":
      return `{ ${Object.entries(expr.fields).map(([key, value]) => `${key}: ${renderExpr(value)}`).join(", ")} }`;
    case "template":
      return `\`${renderTemplate(expr)}\``;
    case "call":
      return `${expr.fn}(${expr.args.map(renderExpr).join(", ")})`;
  }
}

function renderTemplate(template: TemplateIR): string {
  return template.parts
    .map(part => (part.kind === "text" ? part.value : `\${${renderExpr(part.expr)}}`))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function renderLiteral(value: JsonPrimitive): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}
