import type { AgentDefinitionIR, ExprIR, NodeIR, SchemaIR, ScopeIR, WorkflowIR } from "@acpus/core/ir";
import { ansi } from "./terminal-style.js";

const TYPE_ICONS: Record<NodeIR["kind"], string> = {
  agent: "✦",
  task: "$",
  signal: "◌",
  assert: "◈",
  if: "?",
  switch: "⎇",
  parallel: "≡",
  fanout: "✣",
  loop: "↻",
};

const TYPE_COLORS: Record<NodeIR["kind"], number> = {
  agent: 36,
  task: 33,
  signal: 37,
  assert: 91,
  if: 94,
  switch: 34,
  parallel: 96,
  fanout: 35,
  loop: 93,
};

export function renderWorkflowTerminalViz(workflow: WorkflowIR, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const outputShape = workflowOutputShape(workflow);
  const lines = [
    ansi(workflow.name, 1, color),
    `${ansi("input", 2, color)} ${workflow.inputSchema === undefined ? "{}" : schemaSummary(workflow.inputSchema)}`,
    `${ansi("output", 2, color)} ${formatOutputShape(outputShape)}`,
    `${ansi("agents:", 2, color)} ${agentSummary(workflow.agents)}`,
  ];
  if (workflow.root.nodes.length > 0) {
    lines.push("");
    renderScope(workflow.root, "", lines, color, true);
  }
  return lines.join("\n");
}

function workflowOutputShape(workflow: WorkflowIR): OutputShape {
  return exprOutputShape(workflow.root.output, workflow, [workflow.root], new Set());
}

type OutputShape = "leaf" | { [name: string]: OutputShape } | [OutputShape];

function exprOutputShape(
  expr: ExprIR,
  workflow: WorkflowIR,
  scopes: ScopeIR[],
  resolving: Set<NodeIR>,
): OutputShape {
  switch (expr.kind) {
    case "array":
      return [mergeOutputShapes(expr.items.map(item => exprOutputShape(item, workflow, scopes, resolving)))];
    case "object":
      return Object.fromEntries(Object.entries(expr.fields).map(([name, value]) => [
        name,
        exprOutputShape(value, workflow, scopes, resolving),
      ]));
    case "ref":
      return refOutputShape(expr.path, workflow, scopes, resolving);
    default:
      return "leaf";
  }
}

function refOutputShape(
  path: string[],
  workflow: WorkflowIR,
  scopes: ScopeIR[],
  resolving: Set<NodeIR>,
): OutputShape {
  if (path[0] === "input") return projectOutputShape(schemaOutputShape(workflow.inputSchema), path.slice(1));
  if (path[0] !== "nodes" || path[2] !== "output") return "leaf";

  const node = scopes.flatMap(scope => scope.nodes).find(candidate => candidate.id === path[1]);
  return node === undefined
    ? "leaf"
    : projectOutputShape(nodeOutputShape(node, workflow, scopes, resolving), path.slice(3));
}

function nodeOutputShape(
  node: NodeIR,
  workflow: WorkflowIR,
  scopes: ScopeIR[],
  resolving: Set<NodeIR>,
): OutputShape {
  if (resolving.has(node)) return "leaf";
  resolving.add(node);

  let shape: OutputShape;
  switch (node.kind) {
    case "agent":
    case "signal":
      shape = schemaOutputShape(node.outputSchema);
      break;
    case "task":
    case "assert":
      shape = "leaf";
      break;
    case "if":
      shape = mergeOutputShapes([node.then, node.else].map(scope => scopeOutputShape(scope, workflow, scopes, resolving)));
      break;
    case "switch":
      shape = mergeOutputShapes([
        ...node.cases.map(branch => scopeOutputShape(branch.then, workflow, scopes, resolving)),
        scopeOutputShape(node.default, workflow, scopes, resolving),
      ]);
      break;
    case "parallel": {
      const entries = Object.entries(node.branches);
      shape = node.strategy === "all"
        ? Object.fromEntries(entries.map(([name, scope]) => [
            name,
            scopeOutputShape(scope, workflow, scopes, resolving),
          ]))
        : {
            winner: "leaf",
            result: mergeOutputShapes(entries.map(([, scope]) => scopeOutputShape(scope, workflow, scopes, resolving))),
          };
      break;
    }
    case "fanout":
      shape = [scopeOutputShape(node.do, workflow, scopes, resolving)];
      break;
    case "loop":
      shape = exprOutputShape(node.state, workflow, scopes, resolving);
      break;
  }

  resolving.delete(node);
  return shape;
}

function scopeOutputShape(
  scope: ScopeIR,
  workflow: WorkflowIR,
  scopes: ScopeIR[],
  resolving: Set<NodeIR>,
): OutputShape {
  return exprOutputShape(scope.output, workflow, [scope, ...scopes], resolving);
}

function schemaOutputShape(schema: SchemaIR | undefined): OutputShape {
  if (schema?.kind === "array") return [schemaOutputShape(schema.item)];
  if (schema?.kind !== "object") return "leaf";
  const required = new Set(schema.required);
  return Object.fromEntries(Object.entries(schema.fields)
    .filter(([name, field]) => required.has(name) && !field.optional)
    .map(([name, field]) => [name, schemaOutputShape(field)]));
}

function projectOutputShape(shape: OutputShape, path: string[]): OutputShape {
  return path.reduce<OutputShape>((current, segment) => {
    if (current === "leaf") return "leaf";
    if (Array.isArray(current)) return /^\d+$/.test(segment) ? current[0] : "leaf";
    return current[segment] ?? "leaf";
  }, shape);
}

function mergeOutputShapes(shapes: OutputShape[]): OutputShape {
  if (shapes.length === 1) return shapes[0]!;
  if (shapes.length > 0 && shapes.every(isOutputArray)) {
    return [mergeOutputShapes(shapes.map(shape => shape[0]))];
  }
  if (shapes.length > 0 && shapes.every(shape => shape !== "leaf" && !Array.isArray(shape))) {
    const entries = shapes.flatMap(shape => Object.entries(shape));
    return Object.fromEntries([...new Set(entries.map(([name]) => name))].map(name => [
      name,
      mergeOutputShapes(entries.filter(([key]) => key === name).map(([, value]) => value)),
    ]));
  }
  return "leaf";
}

function isOutputArray(shape: OutputShape): shape is [OutputShape] {
  return Array.isArray(shape);
}

function formatOutputShape(shape: OutputShape): string {
  if (shape === "leaf") return "…";
  if (Array.isArray(shape)) return `${formatOutputShape(shape[0])}[]`;
  const fields = outputFields(shape);
  return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
}

function outputFields(shape: OutputShape): string[] {
  if (shape === "leaf" || Array.isArray(shape)) return [];
  return Object.entries(shape).map(([name, child]) =>
    child === "leaf" ? name : `${name}: ${formatOutputShape(child)}`);
}

function schemaSummary(schema: SchemaIR): string {
  let summary: string;
  switch (schema.kind) {
    case "array":
      summary = schemaSummary(schema.item);
      summary = `${schema.item.kind === "union" || schema.item.nullable ? `(${summary})` : summary}[]`;
      break;
    case "object": {
      const required = new Set(schema.required);
      summary = `{ ${Object.entries(schema.fields).map(([name, field]) =>
        `${name}${required.has(name) && !field.optional ? "" : "?"}: ${schemaSummary(field)}`).join(", ")} }`;
      break;
    }
    case "record":
      summary = `Record<string, ${schemaSummary(schema.value)}>`;
      break;
    case "union":
      summary = schema.variants.map(schemaSummary).join(" | ");
      break;
    case "literal":
      summary = JSON.stringify(schema.value);
      break;
    case "enum":
      summary = schema.values.map(value => JSON.stringify(value)).join(" | ");
      break;
    default:
      summary = schema.kind;
  }
  return schema.nullable && schema.kind !== "null" ? `${summary} | null` : summary;
}

function agentSummary(agents: WorkflowIR["agents"]): string {
  const entries = Object.entries(agents);
  if (entries.length === 0) return "none";
  return entries.map(([name, agent]) =>
    `${name} (${[agentTarget(agent), agent.model, agent.agentMode]
      .filter(value => value !== undefined).join(", ")})`).join(" · ");
}

function agentTarget(agent: AgentDefinitionIR): string {
  return agent.kind === "agent_definition" ? agent.use : `$ ${agent.command}`;
}

function renderScope(scope: ScopeIR, prefix: string, lines: string[], color: boolean, root = false): void {
  if (root && scope.nodes.length === 1) {
    renderNode(scope.nodes[0]!, prefix, prefix, lines, color);
    return;
  }

  scope.nodes.forEach((node, index) => {
    const first = index === 0;
    const last = index === scope.nodes.length - 1;
    const connector = root && first ? "┌─" : last ? "└─" : "├─";
    renderNode(node, `${prefix}${connector} `, `${prefix}${last ? "   " : "│  "}`, lines, color);
  });
}

function renderNode(node: NodeIR, linePrefix: string, childPrefix: string, lines: string[], color: boolean): void {
  const detail = node.kind === "agent" ? node.run.agent : node.kind;
  lines.push(`${linePrefix}${ansi(TYPE_ICONS[node.kind], TYPE_COLORS[node.kind], color)} ${node.id}${ansi(` · ${detail}`, 2, color)}`);

  switch (node.kind) {
    case "if":
      renderRegions(childPrefix, lines, color, [
        { label: "then", scope: node.then },
        { label: "else", scope: node.else },
      ]);
      break;
    case "switch":
      renderRegions(childPrefix, lines, color, [
        ...node.cases.map((branch, index) => ({ label: `case ${index + 1}`, scope: branch.then })),
        { label: "default", scope: node.default },
      ]);
      break;
    case "parallel":
      renderRegions(childPrefix, lines, color, Object.entries(node.branches).map(([name, scope]) => ({
        label: name,
        scope,
      })));
      break;
    case "fanout":
      renderScope(node.do, childPrefix, lines, color);
      break;
    case "loop":
      renderScope(node.do, childPrefix, lines, color);
      break;
  }
}

function renderRegions(
  prefix: string,
  lines: string[],
  color: boolean,
  regions: Array<{ label: string; scope: ScopeIR }>,
): void {
  regions.forEach((region, index) => {
    const last = index === regions.length - 1;
    lines.push(`${prefix}${last ? "└┄" : "├┄"} ${region.label}`);
    renderScope(region.scope, `${prefix}${last ? "   " : "│  "}`, lines, color);
  });
}
