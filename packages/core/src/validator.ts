import type { DiagnosticIR, ExprIR, NodeIR, SchemaIR, ScopeIR, WorkflowIR } from "./ir.js";

export function validateWorkflowIR(ir: WorkflowIR): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];
  if (!ir.name || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(ir.name)) {
    diagnostics.push({ code: "W002", severity: "warning", message: `Workflow name '${ir.name}' is not identifier-like. This is allowed but discouraged.` });
  }
  validateSchema(ir.inputSchema, diagnostics, "inputSchema");
  const ids = new Set<string>();
  validateScope(ir.root, diagnostics, { path: "root", ids, agents: new Set(Object.keys(ir.agents)), taskBundles: new Set(Object.keys(ir.assets.taskBundles)) });
  for (const [id, bundle] of Object.entries(ir.assets.taskBundles)) {
    if (id !== bundle.id) diagnostics.push({ code: "T004", severity: "error", message: `Task bundle key '${id}' does not match bundle id '${bundle.id}'.`, path: `assets.taskBundles.${id}` });
    if (!bundle.digest.startsWith("sha256:")) diagnostics.push({ code: "T005", severity: "error", message: `Task bundle '${id}' digest must be sha256:...`, path: `assets.taskBundles.${id}.digest` });
  }
  return diagnostics;
}

type ScopeContext = {
  path: string;
  ids: Set<string>;
  agents: Set<string>;
  taskBundles: Set<string>;
};

function validateScope(scope: ScopeIR, diagnostics: DiagnosticIR[], ctx: ScopeContext): void {
  for (const node of scope.nodes) validateNode(node, diagnostics, ctx);
  for (const expr of Object.values(scope.outputs ?? {})) validateExpr(expr, diagnostics, `${ctx.path}.outputs`);
}

function validateNode(node: NodeIR, diagnostics: DiagnosticIR[], ctx: ScopeContext): void {
  const path = `${ctx.path}.nodes.${node.id}`;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(node.id)) diagnostics.push({ code: "ID001", severity: "error", message: `Invalid node id '${node.id}'.`, path });
  if (ctx.ids.has(node.id)) diagnostics.push({ code: "ID002", severity: "error", message: `Duplicate node id '${node.id}'.`, path });
  ctx.ids.add(node.id);

  switch (node.kind) {
    case "agent": {
      if (!ctx.agents.has(node.run.use)) diagnostics.push({ code: "A001", severity: "error", message: `Agent node '${node.id}' references undeclared agent '${node.run.use}'.`, path: `${path}.run.use` });
      validateExprObject(node.inputs, diagnostics, `${path}.inputs`);
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      validateTemplateExprs(node.run.prompt.parts.map(p => p.kind === "expr" ? p.expr : undefined).filter(Boolean) as ExprIR[], diagnostics, `${path}.run.prompt`);
      break;
    }
    case "task": {
      if (!ctx.taskBundles.has(node.run.bundleId)) diagnostics.push({ code: "T001", severity: "error", message: `Task node '${node.id}' references missing task bundle '${node.run.bundleId}'.`, path: `${path}.run.bundleId` });
      validateExprObject(node.inputs, diagnostics, `${path}.inputs`);
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "signal": {
      validateExprObject(node.inputs, diagnostics, `${path}.inputs`);
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "guard": {
      validateExpr(node.when, diagnostics, `${path}.when`);
      break;
    }
    case "if": {
      validateExpr(node.when, diagnostics, `${path}.when`);
      validateScope(node.then, diagnostics, { ...ctx, path: `${path}.then` });
      if (node.otherwise) validateScope(node.otherwise, diagnostics, { ...ctx, path: `${path}.otherwise` });
      if (!node.outputSchema) diagnostics.push({ code: "G001", severity: "warning", message: `If node '${node.id}' should declare an output schema for stable downstream typing.`, path });
      break;
    }
    case "switch": {
      node.cases.forEach((c, i) => {
        validateExpr(c.when, diagnostics, `${path}.cases.${i}.when`);
        validateScope(c.then, diagnostics, { ...ctx, path: `${path}.cases.${i}.then` });
      });
      if (node.otherwise) validateScope(node.otherwise, diagnostics, { ...ctx, path: `${path}.otherwise` });
      break;
    }
    case "parallel": {
      for (const [name, branch] of Object.entries(node.branches)) validateScope(branch, diagnostics, { ...ctx, path: `${path}.branches.${name}` });
      break;
    }
    case "fanout": {
      validateExpr(node.over, diagnostics, `${path}.over`);
      validateScope(node.do, diagnostics, { ...ctx, path: `${path}.do` });
      break;
    }
    case "loop": {
      if (!Number.isInteger(node.maxIterations) || node.maxIterations <= 0) diagnostics.push({ code: "L001", severity: "error", message: `Loop node '${node.id}' maxIterations must be a positive integer.`, path: `${path}.maxIterations` });
      validateExpr(node.until, diagnostics, `${path}.until`);
      validateScope(node.do, diagnostics, { ...ctx, path: `${path}.do` });
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "call": {
      validateExprObject(node.inputs, diagnostics, `${path}.inputs`);
      break;
    }
  }
}

function validateExprObject(values: Record<string, ExprIR>, diagnostics: DiagnosticIR[], path: string): void {
  for (const [key, expr] of Object.entries(values)) validateExpr(expr, diagnostics, `${path}.${key}`);
}

function validateTemplateExprs(exprs: ExprIR[], diagnostics: DiagnosticIR[], path: string): void {
  exprs.forEach((expr, index) => validateExpr(expr, diagnostics, `${path}.parts.${index}`));
}

function validateExpr(expr: ExprIR, diagnostics: DiagnosticIR[], path: string): void {
  switch (expr.kind) {
    case "literal": return;
    case "ref": {
      if (expr.path.length === 0) diagnostics.push({ code: "E001", severity: "error", message: "Expression ref path cannot be empty.", path });
      return;
    }
    case "call": {
      if (!expr.fn) diagnostics.push({ code: "E002", severity: "error", message: "Expression call fn cannot be empty.", path });
      expr.args.forEach((arg, i) => validateExpr(arg, diagnostics, `${path}.args.${i}`));
      return;
    }
    case "array": expr.items.forEach((item, i) => validateExpr(item, diagnostics, `${path}.items.${i}`)); return;
    case "object": validateExprObject(expr.fields, diagnostics, `${path}.fields`); return;
    case "template": {
      expr.template.parts.forEach((part, i) => { if (part.kind === "expr") validateExpr(part.expr, diagnostics, `${path}.template.parts.${i}`); });
      return;
    }
  }
}

function validateSchema(schema: SchemaIR | undefined, diagnostics: DiagnosticIR[], path: string): void {
  if (!schema) return;
  switch (schema.kind) {
    case "object": {
      for (const req of schema.required) if (!(req in schema.fields)) diagnostics.push({ code: "SC001", severity: "error", message: `Required field '${req}' is not present in object fields.`, path });
      for (const [key, field] of Object.entries(schema.fields)) validateSchema(field as SchemaIR, diagnostics, `${path}.fields.${key}`);
      break;
    }
    case "array": validateSchema(schema.item as SchemaIR, diagnostics, `${path}.item`); break;
    case "record": validateSchema(schema.value as SchemaIR, diagnostics, `${path}.value`); break;
    case "union": schema.variants.forEach((v, i) => validateSchema(v as SchemaIR, diagnostics, `${path}.variants.${i}`)); break;
  }
}
