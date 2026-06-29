import type { DiagnosticIR, ExprIR, NodeIR, SchemaIR, SecretRefIR, TemplateIR, WorkflowIR } from "./types.js";

export function validateWorkflowIR(ir: WorkflowIR): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];
  validateKnownFields(ir, ["irVersion", "name", "inputSchema", "agents", "root", "outputs", "assets", "lock", "diagnostics"], diagnostics, "");
  if (!ir.name || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(ir.name)) {
    diagnostics.push({ code: "W002", severity: "warning", message: `Workflow name '${ir.name}' is not identifier-like. This is allowed but discouraged.` });
  }
  validateSchema(ir.inputSchema, diagnostics, "inputSchema");
  validateAgents(ir.agents, diagnostics);
  const ids = new Set<string>();
  validateScope(ir.root, diagnostics, { path: "root", ids, agents: new Set(Object.keys(ir.agents)), taskBundles: new Map(Object.entries(ir.assets.taskBundles)) });
  for (const [id, bundle] of Object.entries(ir.assets.taskBundles)) {
    validateKnownFields(bundle, ["id", "digest", "runtime", "source", "sourceFile", "inline"], diagnostics, `assets.taskBundles.${id}`);
    if (id !== bundle.id) diagnostics.push({ code: "T004", severity: "error", message: `Task bundle key '${id}' does not match bundle id '${bundle.id}'.`, path: `assets.taskBundles.${id}` });
    if (!bundle.digest.startsWith("sha256:")) diagnostics.push({ code: "T005", severity: "error", message: `Task bundle '${id}' digest must be sha256:...`, path: `assets.taskBundles.${id}.digest` });
    if (typeof bundle.source !== "string" || bundle.source.length === 0) diagnostics.push({ code: "T006", severity: "error", message: `Task bundle '${id}' must include bundled source.`, path: `assets.taskBundles.${id}.source` });
  }
  return diagnostics;
}

function validateAgents(agents: WorkflowIR["agents"], diagnostics: DiagnosticIR[]): void {
  for (const [name, agent] of Object.entries(agents)) {
    const path = `agents.${name}`;
    if (!isRecord(agent)) {
      diagnostics.push({ code: "A002", severity: "error", message: `Agent '${name}' definition must be an object.`, path });
      continue;
    }
    if (agent.kind === "agent_definition") {
      validateKnownFields(agent, ["kind", "use", "model", "policy", "cwd", "env", "options"], diagnostics, path);
      if (typeof (agent as { use?: unknown }).use !== "string" || agent.use.length === 0) {
        diagnostics.push({ code: "A002", severity: "error", message: `Agent '${name}' use must be a non-empty string.`, path: `${path}.use` });
      }
      if (agent.cwd) validateExpr(agent.cwd, diagnostics, `${path}.cwd`);
      validateEnv(agent.env, diagnostics, `${path}.env`);
      continue;
    }

    if (agent.kind === "agent_command") {
      validateKnownFields(agent, ["kind", "command", "policy", "cwd", "env", "options"], diagnostics, path);
      if (typeof (agent as { command?: unknown }).command !== "string" || agent.command.length === 0) {
        diagnostics.push({ code: "A002", severity: "error", message: `Command-backed agent '${name}' command must be a non-empty string.`, path: `${path}.command` });
      }
      if (agent.cwd) validateExpr(agent.cwd, diagnostics, `${path}.cwd`);
      validateEnv(agent.env, diagnostics, `${path}.env`);
      continue;
    }

    diagnostics.push({ code: "A002", severity: "error", message: `Agent '${name}' kind must be agent_definition or agent_command.`, path });
  }
}

type ScopeContext = {
  path: string;
  ids: Set<string>;
  agents: Set<string>;
  taskBundles: Map<string, WorkflowIR["assets"]["taskBundles"][string]>;
};

function validateScope(scope: unknown, diagnostics: DiagnosticIR[], ctx: ScopeContext): void {
  if (!isRecord(scope)) {
    diagnostics.push({ code: "IR002", severity: "error", message: "Scope must be an object.", path: ctx.path });
    return;
  }
  validateKnownFields(scope, ["nodes", "outputs"], diagnostics, ctx.path);
  if (!Array.isArray(scope.nodes)) {
    diagnostics.push({ code: "IR002", severity: "error", message: "Scope nodes must be an array.", path: `${ctx.path}.nodes` });
    return;
  }
  scope.nodes.forEach(node => validateNode(node, diagnostics, ctx));
  if (scope.outputs !== undefined) validateExprObject(scope.outputs, diagnostics, `${ctx.path}.outputs`);
}

function validateNode(node: NodeIR, diagnostics: DiagnosticIR[], ctx: ScopeContext): void {
  if (!isRecord(node)) {
    diagnostics.push({ code: "IR002", severity: "error", message: "Node must be an object.", path: `${ctx.path}.nodes` });
    return;
  }
  const id = typeof node.id === "string" ? node.id : "<unknown>";
  const path = `${ctx.path}.nodes.${id}`;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) diagnostics.push({ code: "ID001", severity: "error", message: `Invalid node id '${id}'.`, path });
  if (ctx.ids.has(id)) diagnostics.push({ code: "ID002", severity: "error", message: `Duplicate node id '${id}'.`, path });
  ctx.ids.add(id);

  switch (node.kind) {
    case "agent": {
      validateKnownFields(node, ["id", "source", "kind", "outputSchema", "run", "timeout", "retry"], diagnostics, path);
      validateAgentRun(node.run, diagnostics, `${path}.run`);
      const agentKey = isRecord(node.run) && typeof node.run.agent === "string" ? node.run.agent : undefined;
      if (agentKey && !ctx.agents.has(agentKey)) diagnostics.push({ code: "A001", severity: "error", message: `Agent node '${node.id}' references undeclared agent '${agentKey}'.`, path: `${path}.run.agent` });
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "task": {
      validateKnownFields(node, ["id", "source", "kind", "outputSchema", "run", "timeout", "retry"], diagnostics, path);
      validateTaskRun(node.run, diagnostics, `${path}.run`);
      const bundleId = isRecord(node.run) && typeof node.run.bundleId === "string" ? node.run.bundleId : undefined;
      if (bundleId && !ctx.taskBundles.has(bundleId)) diagnostics.push({ code: "T001", severity: "error", message: `Task node '${node.id}' references missing task bundle '${bundleId}'.`, path: `${path}.run.bundleId` });
      if (bundleId && ctx.taskBundles.has(bundleId)) validateTaskRunDigest(node.run, ctx.taskBundles.get(bundleId), diagnostics, `${path}.run`);
      validateRequiredSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "signal": {
      validateKnownFields(node, ["id", "source", "kind", "outputSchema", "run", "timeout", "onTimeout"], diagnostics, path);
      validateSignalRun(node.run, diagnostics, `${path}.run`);
      validateSignalTimeout(node.onTimeout, diagnostics, `${path}.onTimeout`, node.id);
      validateRequiredSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "assert": {
      validateKnownFields(node, ["id", "source", "kind", "condition", "message"], diagnostics, path);
      validateExpr(node.condition, diagnostics, `${path}.condition`);
      if (node.message) validateTemplate(node.message, diagnostics, `${path}.message`);
      break;
    }
    case "if": {
      validateKnownFields(node, ["id", "source", "kind", "condition", "then", "else", "outputSchema"], diagnostics, path);
      validateExpr(node.condition, diagnostics, `${path}.condition`);
      validateScope(node.then, diagnostics, { ...ctx, path: `${path}.then` });
      if (node.else) validateScope(node.else, diagnostics, { ...ctx, path: `${path}.else` });
      if (node.outputSchema && !node.else) diagnostics.push({ code: "G002", severity: "error", message: `If node '${node.id}' with outputSchema must declare else.`, path: `${path}.else` });
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "switch": {
      validateKnownFields(node, ["id", "source", "kind", "cases", "default", "outputSchema"], diagnostics, path);
      if (!Array.isArray(node.cases)) {
        diagnostics.push({ code: "IR002", severity: "error", message: "Switch cases must be an array.", path: `${path}.cases` });
      } else {
        node.cases.forEach((c, i) => {
          const casePath = `${path}.cases.${i}`;
          if (!isRecord(c)) {
            diagnostics.push({ code: "IR002", severity: "error", message: "Switch case must be an object.", path: casePath });
            return;
          }
          validateKnownFields(c, ["when", "then"], diagnostics, casePath);
          validateExpr(c.when, diagnostics, `${casePath}.when`);
          validateScope(c.then, diagnostics, { ...ctx, path: `${casePath}.then` });
        });
      }
      if (node.default) validateScope(node.default, diagnostics, { ...ctx, path: `${path}.default` });
      if (node.outputSchema && !node.default) diagnostics.push({ code: "G003", severity: "error", message: `Switch node '${node.id}' with outputSchema must declare default.`, path: `${path}.default` });
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "parallel": {
      validateKnownFields(node, ["id", "source", "kind", "branches", "strategy", "maxConcurrency"], diagnostics, path);
      if (node.strategy !== "all" && node.strategy !== "race") diagnostics.push({ code: "P001", severity: "error", message: `Parallel node '${node.id}' strategy must be 'all' or 'race'.`, path: `${path}.strategy` });
      if (!isRecord(node.branches)) {
        diagnostics.push({ code: "IR002", severity: "error", message: "Parallel branches must be an object.", path: `${path}.branches` });
        break;
      }
      if (node.strategy === "race" && Object.keys(node.branches).length === 0) diagnostics.push({ code: "P002", severity: "error", message: `Parallel race node '${node.id}' must declare at least one branch.`, path: `${path}.branches` });
      for (const [name, branch] of Object.entries(node.branches)) {
        const branchPath = `${path}.branches.${name}`;
        if (!isRecord(branch)) {
          diagnostics.push({ code: "IR002", severity: "error", message: "Parallel branch must be an object.", path: branchPath });
          continue;
        }
        validateKnownFields(branch, ["outputSchema", "scope"], diagnostics, branchPath);
        validateRequiredSchema(branch.outputSchema, diagnostics, `${branchPath}.outputSchema`);
        validateScope(branch.scope, diagnostics, { ...ctx, path: `${branchPath}.scope` });
      }
      break;
    }
    case "fanout": {
      validateKnownFields(node, ["id", "source", "kind", "over", "key", "do", "maxConcurrency", "itemOutputSchema", "strategy", "count"], diagnostics, path);
      const strategy = (node as { strategy?: string }).strategy;
      const count = (node as { count?: number }).count;
      if (strategy !== "all" && strategy !== "quorum") diagnostics.push({ code: "F001", severity: "error", message: `Fanout node '${node.id}' strategy must be 'all' or 'quorum'.`, path: `${path}.strategy` });
      if (strategy === "quorum" && (!Number.isInteger(count) || (count ?? 0) <= 0)) diagnostics.push({ code: "F002", severity: "error", message: `Fanout node '${node.id}' quorum count must be a positive integer.`, path: `${path}.count` });
      if (strategy !== "quorum" && count !== undefined) diagnostics.push({ code: "F003", severity: "error", message: `Fanout node '${node.id}' count is only valid with quorum strategy.`, path: `${path}.count` });
      const validOver = validateExpr(node.over, diagnostics, `${path}.over`);
      if (validOver) validateFanoutOver(node.over, diagnostics, `${path}.over`);
      if (node.key) validateTemplate(node.key, diagnostics, `${path}.key`);
      validateRequiredSchema(node.itemOutputSchema, diagnostics, `${path}.itemOutputSchema`);
      validateScope(node.do, diagnostics, { ...ctx, path: `${path}.do` });
      break;
    }
    case "loop": {
      validateKnownFields(node, ["id", "source", "kind", "maxIterations", "do", "stopWhen", "onExhausted", "outputSchema"], diagnostics, path);
      if (!Number.isInteger(node.maxIterations) || node.maxIterations <= 0) diagnostics.push({ code: "L001", severity: "error", message: `Loop node '${node.id}' maxIterations must be a positive integer.`, path: `${path}.maxIterations` });
      if (node.onExhausted !== undefined && node.onExhausted !== "fail" && node.onExhausted !== "returnLast") diagnostics.push({ code: "L002", severity: "error", message: `Loop node '${node.id}' onExhausted must be 'fail' or 'returnLast'.`, path: `${path}.onExhausted` });
      validateExpr(node.stopWhen, diagnostics, `${path}.stopWhen`);
      validateScope(node.do, diagnostics, { ...ctx, path: `${path}.do` });
      validateRequiredSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    default:
      diagnostics.push({ code: "N001", severity: "error", message: `Unknown node kind '${String((node as { kind?: unknown }).kind)}'.`, path: `${path}.kind` });
  }
}

function validateAgentRun(run: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(run)) {
    diagnostics.push({ code: "A003", severity: "error", message: "Agent run must be an object.", path });
    return;
  }
  validateKnownFields(run, ["kind", "agent", "prompt", "policy", "session", "cwd", "env"], diagnostics, path);
  if (run.kind !== "agent_run") diagnostics.push({ code: "A003", severity: "error", message: "Agent run kind must be agent_run.", path: `${path}.kind` });
  if (typeof run.agent !== "string" || run.agent.length === 0) diagnostics.push({ code: "A003", severity: "error", message: "Agent run agent must be a non-empty string.", path: `${path}.agent` });
  validateTemplate(run.prompt, diagnostics, `${path}.prompt`);
  if (run.session !== undefined) {
    if (!isRecord(run.session)) {
      diagnostics.push({ code: "A003", severity: "error", message: "Agent run session must be an object.", path: `${path}.session` });
    } else {
      validateKnownFields(run.session, ["key"], diagnostics, `${path}.session`);
      if (run.session.key) validateTemplate(run.session.key, diagnostics, `${path}.session.key`);
    }
  }
  if (run.cwd) validateExpr(run.cwd, diagnostics, `${path}.cwd`);
  validateEnv(run.env, diagnostics, `${path}.env`);
}

function validateTaskRun(run: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(run)) {
    diagnostics.push({ code: "T007", severity: "error", message: "Task run must be an object.", path });
    return;
  }
  validateKnownFields(run, ["kind", "input", "bundleId", "exportName", "digest", "runtime", "inline", "params", "cwd", "env", "execution"], diagnostics, path);
  if (run.kind !== "task_run") diagnostics.push({ code: "T007", severity: "error", message: "Task run kind must be task_run.", path: `${path}.kind` });
  validateExprObject(run.input, diagnostics, `${path}.input`);
  if (typeof run.bundleId !== "string" || run.bundleId.length === 0) diagnostics.push({ code: "T007", severity: "error", message: "Task run bundleId must be a non-empty string.", path: `${path}.bundleId` });
  if (run.cwd) validateExpr(run.cwd, diagnostics, `${path}.cwd`);
  validateEnv(run.env, diagnostics, `${path}.env`);
  validateTaskExecution(run.execution, diagnostics, `${path}.execution`);
}

function validateTaskRunDigest(run: unknown, bundle: WorkflowIR["assets"]["taskBundles"][string] | undefined, diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(run) || !bundle) return;
  if (run.digest !== bundle.digest) {
    diagnostics.push({
      code: "T008",
      severity: "error",
      message: `Task run digest '${String(run.digest)}' does not match bundle digest '${bundle.digest}'.`,
      path: `${path}.digest`,
    });
  }
}

function validateSignalRun(run: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(run)) {
    diagnostics.push({ code: "S002", severity: "error", message: "Signal run must be an object.", path });
    return;
  }
  validateKnownFields(run, ["kind", "prompt"], diagnostics, path);
  if (run.kind !== "signal_run") diagnostics.push({ code: "S002", severity: "error", message: "Signal run kind must be signal_run.", path: `${path}.kind` });
  validateTemplate(run.prompt, diagnostics, `${path}.prompt`);
}

function validateSignalTimeout(onTimeout: unknown, diagnostics: DiagnosticIR[], path: string, id: string): void {
  if (!onTimeout) return;
  if (!isRecord(onTimeout)) {
    diagnostics.push({ code: "S001", severity: "error", message: `Signal node '${id}' onTimeout must be an object.`, path });
    return;
  }
  validateKnownFields(onTimeout, ["action", "message"], diagnostics, path);
  if (onTimeout.action !== "fail") diagnostics.push({ code: "S001", severity: "error", message: `Signal node '${id}' onTimeout action must be 'fail'.`, path: `${path}.action` });
}

function validateFanoutOver(expr: ExprIR, diagnostics: DiagnosticIR[], path: string): void {
  if (expr.kind === "literal" && !Array.isArray(expr.value)) {
    diagnostics.push({ code: "F004", severity: "error", message: "Fanout over literal must be an array.", path });
  }
  if (expr.kind === "object") {
    diagnostics.push({ code: "F004", severity: "error", message: "Fanout over object expression must be an array value.", path });
  }
}

function validateExprObject(values: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!values) {
    diagnostics.push({ code: "E000", severity: "error", message: "Expression object is required.", path });
    return;
  }
  if (!isRecord(values)) {
    diagnostics.push({ code: "E004", severity: "error", message: "Expression object fields must be an object.", path });
    return;
  }
  for (const [key, expr] of Object.entries(values)) validateExpr(expr, diagnostics, `${path}.${key}`);
}

function validateEnv(values: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (values === undefined) return;
  if (!isRecord(values)) {
    diagnostics.push({ code: "E004", severity: "error", message: "Env must be an object.", path });
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    if (isSecretRef(value)) {
      validateSecretRef(value, diagnostics, `${path}.${key}`);
      continue;
    }
    validateExpr(value, diagnostics, `${path}.${key}`);
  }
}

function validateSecretRef(value: SecretRefIR, diagnostics: DiagnosticIR[], path: string): void {
  validateKnownFields(value, ["kind", "name"], diagnostics, path);
  if (typeof value.name !== "string" || value.name.length === 0) {
    diagnostics.push({ code: "SEC001", severity: "error", message: "Secret ref name must be a non-empty string.", path: `${path}.name` });
  }
}

function validateTemplate(template: unknown, diagnostics: DiagnosticIR[], path: string): boolean {
  if (!template) {
    diagnostics.push({ code: "TM001", severity: "error", message: "Template is required.", path });
    return false;
  }
  if (!isRecord(template) || template.kind !== "template" || !Array.isArray(template.parts)) {
    diagnostics.push({ code: "TM001", severity: "error", message: "Template must be a template object with parts.", path });
    return false;
  }
  validateKnownFields(template, ["kind", "parts"], diagnostics, path);
  template.parts.forEach((part, index) => {
    const partPath = `${path}.parts.${index}`;
    if (!isRecord(part)) {
      diagnostics.push({ code: "TM002", severity: "error", message: "Template part must be an object.", path: partPath });
      return;
    }
    if (part.kind === "text") {
      validateKnownFields(part, ["kind", "value"], diagnostics, partPath);
      if (typeof part.value !== "string") diagnostics.push({ code: "TM002", severity: "error", message: "Template text value must be a string.", path: `${partPath}.value` });
      return;
    }
    if (part.kind === "expr") {
      validateKnownFields(part, ["kind", "expr"], diagnostics, partPath);
      validateExpr(part.expr, diagnostics, `${partPath}.expr`);
      return;
    }
    diagnostics.push({ code: "TM002", severity: "error", message: `Unknown template part kind '${String(part.kind)}'.`, path: `${partPath}.kind` });
  });
  return true;
}

function validateTaskExecution(execution: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!execution) return;
  if (!isRecord(execution)) {
    diagnostics.push({ code: "T006", severity: "error", message: "Task execution must be an object.", path });
    return;
  }
  validateKnownFields(execution, ["shell", "defaultCommandTimeout", "commandRunner"], diagnostics, path);
  if (execution.shell !== undefined && execution.shell !== "bash" && execution.shell !== "powershell" && execution.shell !== "pwsh") {
    diagnostics.push({ code: "T006", severity: "error", message: "Task execution shell must be bash, powershell, or pwsh.", path: `${path}.shell` });
  }
  if (execution.defaultCommandTimeout !== undefined && typeof execution.defaultCommandTimeout !== "string") {
    diagnostics.push({ code: "T006", severity: "error", message: "Task defaultCommandTimeout must be a duration string.", path: `${path}.defaultCommandTimeout` });
  }
  if (execution.commandRunner !== undefined && execution.commandRunner !== "acpus-zx-core" && execution.commandRunner !== "custom") {
    diagnostics.push({ code: "T006", severity: "error", message: "Task commandRunner must be acpus-zx-core or custom.", path: `${path}.commandRunner` });
  }
}

function validateExpr(expr: unknown, diagnostics: DiagnosticIR[], path: string): expr is ExprIR {
  if (expr === undefined || expr === null) {
    diagnostics.push({ code: "E000", severity: "error", message: "Expression is required.", path });
    return false;
  }
  if (!isRecord(expr) || typeof expr.kind !== "string") {
    diagnostics.push({ code: "E004", severity: "error", message: "Expression must be an object with kind.", path });
    return false;
  }
  switch (expr.kind) {
    case "literal": {
      validateKnownFields(expr, ["kind", "value", "type"], diagnostics, path);
      if (!Object.prototype.hasOwnProperty.call(expr, "value")) diagnostics.push({ code: "E003", severity: "error", message: "Expression literal must include value.", path: `${path}.value` });
      return true;
    }
    case "ref": {
      validateKnownFields(expr, ["kind", "path", "type"], diagnostics, path);
      if (!Array.isArray(expr.path) || expr.path.length === 0 || expr.path.some(item => typeof item !== "string")) {
        diagnostics.push({ code: "E001", severity: "error", message: "Expression ref path must be a non-empty string array.", path: `${path}.path` });
      }
      return true;
    }
    case "call": {
      validateKnownFields(expr, ["kind", "fn", "args", "type"], diagnostics, path);
      if (typeof expr.fn !== "string" || expr.fn.length === 0) diagnostics.push({ code: "E002", severity: "error", message: "Expression call fn cannot be empty.", path: `${path}.fn` });
      if (!Array.isArray(expr.args)) {
        diagnostics.push({ code: "E004", severity: "error", message: "Expression call args must be an array.", path: `${path}.args` });
        return true;
      }
      expr.args.forEach((arg, i) => validateExpr(arg, diagnostics, `${path}.args.${i}`));
      return true;
    }
    case "array": {
      validateKnownFields(expr, ["kind", "items", "type"], diagnostics, path);
      if (!Array.isArray(expr.items)) {
        diagnostics.push({ code: "E004", severity: "error", message: "Expression array items must be an array.", path: `${path}.items` });
        return true;
      }
      expr.items.forEach((item, i) => validateExpr(item, diagnostics, `${path}.items.${i}`));
      return true;
    }
    case "object": {
      validateKnownFields(expr, ["kind", "fields", "type"], diagnostics, path);
      validateExprObject(expr.fields, diagnostics, `${path}.fields`);
      return true;
    }
    case "template": {
      validateKnownFields(expr, ["kind", "template", "type"], diagnostics, path);
      validateTemplate(expr.template as TemplateIR | undefined, diagnostics, `${path}.template`);
      return true;
    }
    default:
      diagnostics.push({ code: "E004", severity: "error", message: `Unknown expression kind '${expr.kind}'.`, path: `${path}.kind` });
      return false;
  }
}

function validateSchema(schema: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!schema) return;
  if (!isRecord(schema) || typeof schema.kind !== "string") {
    diagnostics.push({ code: "SC002", severity: "error", message: "Schema must be an object with kind.", path });
    return;
  }
  switch (schema.kind) {
    case "object": {
      if (!isRecord(schema.fields)) diagnostics.push({ code: "SC002", severity: "error", message: "Object schema fields must be an object.", path: `${path}.fields` });
      const fields = isRecord(schema.fields) ? schema.fields : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (!Array.isArray(schema.required)) diagnostics.push({ code: "SC002", severity: "error", message: "Object schema required must be an array.", path: `${path}.required` });
      for (const req of required) if (typeof req !== "string" || !(req in fields)) diagnostics.push({ code: "SC001", severity: "error", message: `Required field '${String(req)}' is not present in object fields.`, path });
      for (const [key, field] of Object.entries(fields)) validateSchema(field as SchemaIR, diagnostics, `${path}.fields.${key}`);
      break;
    }
    case "array": validateSchema(schema.item as SchemaIR, diagnostics, `${path}.item`); break;
    case "record": validateSchema(schema.value as SchemaIR, diagnostics, `${path}.value`); break;
    case "union": {
      if (!Array.isArray(schema.variants)) {
        diagnostics.push({ code: "SC002", severity: "error", message: "Union schema variants must be an array.", path: `${path}.variants` });
        break;
      }
      schema.variants.forEach((v, i) => validateSchema(v as SchemaIR, diagnostics, `${path}.variants.${i}`));
      break;
    }
  }
}

function validateRequiredSchema(schema: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!schema) {
    diagnostics.push({ code: "SC000", severity: "error", message: "Schema is required.", path });
    return;
  }
  validateSchema(schema, diagnostics, path);
}

function validateKnownFields(value: unknown, allowed: readonly string[], diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(value)) return;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      diagnostics.push({
        code: "IR001",
        severity: "error",
        message: `Unexpected field '${key}'.`,
        path: path ? `${path}.${key}` : key,
      });
    }
  }
}

function isSecretRef(value: unknown): value is SecretRefIR {
  return isRecord(value) && value.kind === "secret";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
