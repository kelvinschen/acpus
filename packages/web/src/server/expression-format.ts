import type { ExprIR, JsonValue, TemplateIR } from "@acpus/expression/ir";

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
      return `\`${renderTemplate(expr.template)}\``;
    case "call":
      return `${expr.fn}(${expr.args.map(renderExpr).join(", ")})`;
  }
}

export function renderPromptExpr(expr: ExprIR): string {
  if (expr.kind === "literal" && typeof expr.value === "string") return expr.value;
  if (expr.kind === "template") return renderTemplate(expr.template);
  return renderExpr(expr);
}

function renderTemplate(template: TemplateIR): string {
  return template.parts
    .map(part => (part.kind === "text" ? part.value : `\${${renderExpr(part.expr)}}`))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function renderLiteral(value: JsonValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(renderLiteral).join(", ")}]`;
  if (typeof value === "object") return `{ ${Object.entries(value).map(([key, item]) => `${key}: ${renderLiteral(item)}`).join(", ")} }`;
  return String(value);
}
