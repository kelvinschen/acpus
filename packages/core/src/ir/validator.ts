import { isJsonValue } from "@acpus/expression/ir";
import { validateExprIR, type ExpressionDiagnostic } from "@acpus/expression/validator";
import { tryParseDurationMs } from "./duration.js";
import { isPositiveInteger } from "./integer.js";
import type { DiagnosticIR, ExprIR, NodeIR, SchemaIR, TemplateIR, WorkflowIR } from "./types.js";

export function validateWorkflowIR(ir: WorkflowIR): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];
  if (!isRecord(ir)) {
    addError(diagnostics, "IR002", "WorkflowIR must be an object.", "");
    return diagnostics;
  }
  validateKnownFields(ir, ["irVersion", "name", "description", "inputSchema", "agents", "root", "diagnostics"], diagnostics, "");
  if (ir.irVersion !== 5) addError(diagnostics, "IR002", "WorkflowIR irVersion must be 5.", "irVersion");
  if (!ir.name || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(ir.name)) {
    addWarning(diagnostics, "W002", `Workflow name '${ir.name}' is not identifier-like. This is allowed but discouraged.`);
  }
  if (ir.description !== undefined && typeof ir.description !== "string") {
    addError(diagnostics, "IR002", "WorkflowIR description must be a string.", "description");
  }
  validateSchema(ir.inputSchema, diagnostics, "inputSchema");
  const agents = isRecord(ir.agents) ? ir.agents : undefined;
  if (!agents) addError(diagnostics, "IR002", "WorkflowIR agents must be an object.", "agents");
  else validateAgents(agents, diagnostics);
  validateDiagnostics(ir.diagnostics, diagnostics, "diagnostics");
  const ids = new Set<string>();
  const rootVisibleNodes = new Set<string>();
  validateScope(ir.root, diagnostics, {
    path: "root",
    ids,
    agents: new Set(agents ? Object.keys(agents) : []),
    visibleNodes: rootVisibleNodes,
    fanoutIds: new Set(),
    loopIds: new Set(),
  });
  return diagnostics;
}

function validateDiagnostics(value: unknown, diagnostics: DiagnosticIR[], path: string): void {
  const items = requireArray<unknown>(value, diagnostics, path, "IR002", "WorkflowIR diagnostics must be an array.");
  if (!items) return;
  forEachDense(items, diagnostics, path, (diagnostic, index) => {
    if (!requireRecord(diagnostic, diagnostics, `${path}.${index}`, "IR002", "WorkflowIR diagnostic entries must be objects.")) {
      return;
    }
    validateKnownFields(diagnostic, ["code", "severity", "message", "path", "source", "hint"], diagnostics, `${path}.${index}`);
    validateRequiredNonEmptyString(diagnostic.code, diagnostics, `${path}.${index}.code`, "IR002", "WorkflowIR diagnostic code must be a non-empty string.");
    validateRequiredEnum(diagnostic.severity, ["error", "warning", "info"], diagnostics, `${path}.${index}.severity`, "IR002", "WorkflowIR diagnostic severity must be error, warning, or info.");
    validateRequiredNonEmptyString(diagnostic.message, diagnostics, `${path}.${index}.message`, "IR002", "WorkflowIR diagnostic message must be a non-empty string.");
  }, { code: "IR002" });
}

function validateAgents(agents: WorkflowIR["agents"], diagnostics: DiagnosticIR[]): void {
  for (const [name, agent] of Object.entries(agents)) {
    const path = `agents.${name}`;
    if (!requireRecord(agent, diagnostics, path, "A002", `Agent '${name}' definition must be an object.`)) continue;
    if (agent.kind === "agent_definition") {
      validateKnownFields(agent, ["kind", "use", "model", "permissionMode", "agentMode", "trace", "cwd", "env"], diagnostics, path);
      validateRequiredNonEmptyString(agent.use, diagnostics, `${path}.use`, "A002", `Agent '${name}' use must be a non-empty string.`);
      validatePermissionMode(agent.permissionMode, diagnostics, `${path}.permissionMode`);
      validateAgentMode(agent.agentMode, diagnostics, `${path}.agentMode`);
      validateAgentTrace(agent.trace, diagnostics, `${path}.trace`);
      if (agent.cwd !== undefined) validateRequiredNonEmptyString(agent.cwd, diagnostics, `${path}.cwd`, "A002", `Agent '${name}' cwd must be a non-empty string.`);
      validateStaticEnv(agent.env, diagnostics, `${path}.env`);
      continue;
    }

    if (agent.kind === "agent_command") {
      validateKnownFields(agent, ["kind", "command", "model", "permissionMode", "agentMode", "trace", "cwd", "env"], diagnostics, path);
      validateRequiredNonEmptyString(agent.command, diagnostics, `${path}.command`, "A002", `Command-backed agent '${name}' command must be a non-empty string.`);
      validatePermissionMode(agent.permissionMode, diagnostics, `${path}.permissionMode`);
      validateAgentMode(agent.agentMode, diagnostics, `${path}.agentMode`);
      validateAgentTrace(agent.trace, diagnostics, `${path}.trace`);
      if (agent.cwd !== undefined) validateRequiredNonEmptyString(agent.cwd, diagnostics, `${path}.cwd`, "A002", `Agent '${name}' cwd must be a non-empty string.`);
      validateStaticEnv(agent.env, diagnostics, `${path}.env`);
      continue;
    }

    addError(diagnostics, "A002", `Agent '${name}' kind must be agent_definition or agent_command.`, path);
  }
}

type IrScopeContext = {
  path: string;
  ids: Set<string>;
  agents: Set<string>;
  visibleNodes: Set<string>;
  fanoutIds: Set<string>;
  loopIds: Set<string>;
};

function validateScope(scope: unknown, diagnostics: DiagnosticIR[], ctx: IrScopeContext): void {
  if (!requireRecord(scope, diagnostics, ctx.path, "IR002", "Scope must be an object.")) return;
  validateKnownFields(scope, ["nodes", "output"], diagnostics, ctx.path);
  const nodes = requireArray<unknown>(scope.nodes, diagnostics, `${ctx.path}.nodes`, "IR002", "Scope nodes must be an array.");
  if (nodes) {
    forEachDense(nodes, diagnostics, `${ctx.path}.nodes`, node => {
      const id = nodeId(node);
      validateNode(node as NodeIR, diagnostics, ctx);
      if (id) ctx.visibleNodes.add(id);
    }, { code: "IR002" });
  }
  if (scope.output === undefined) addError(diagnostics, "IR002", "Scope output is required.", `${ctx.path}.output`);
  else validateExpr(scope.output, diagnostics, `${ctx.path}.output`, refsFromScope(ctx));
}

function validateLoopTransitionScope(scope: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!requireRecord(scope, diagnostics, path, "IR002", "Scope must be an object.")) return;
  if (!requireRecord(scope.output, diagnostics, `${path}.output`, "E004", "Loop body output must be an object expression.")) return;
  if (scope.output.kind !== "object") {
    addError(diagnostics, "E004", "Loop body output must be an object expression.", `${path}.output`);
    return;
  }
  if (!requireRecord(scope.output.fields, diagnostics, `${path}.output.fields`, "E004", "Loop body output must be an object expression.")) return;
  validateKnownFields(scope.output.fields, ["state", "stop"], diagnostics, `${path}.output.fields`);
  if (scope.output.fields.state === undefined) addError(diagnostics, "E000", "Loop body transition state is required.", `${path}.output.fields.state`);
  if (scope.output.fields.stop === undefined) addError(diagnostics, "E000", "Loop body transition stop is required.", `${path}.output.fields.stop`);
}

function validateNode(node: NodeIR, diagnostics: DiagnosticIR[], ctx: IrScopeContext): void {
  if (!requireRecord(node, diagnostics, `${ctx.path}.nodes`, "IR002", "Node must be an object.")) return;
  const id = typeof node.id === "string" ? node.id : "<unknown>";
  const path = `${ctx.path}.nodes.${id}`;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
    diagnostics.push({
      code: "ID001",
      severity: "error",
      message: `Invalid node id '${id}'. Expected /^[A-Za-z_][A-Za-z0-9_-]*$/.`,
      path,
      hint: "Use a compile-time string literal for the step id; runtime Expr values are not allowed in node ids.",
    });
  }
  if (ctx.ids.has(id)) addError(diagnostics, "ID002", `Duplicate node id '${id}'.`, path);
  ctx.ids.add(id);

  switch (node.kind) {
    case "agent": {
      validateKnownFields(node, ["id", "kind", "outputSchema", "run", "timeout"], diagnostics, path);
      validateDurationExpr(node.timeout, diagnostics, `${path}.timeout`, `Agent node '${node.id}' timeout`, "IR002", refsFromScope(ctx));
      validateAgentRun(node.run, diagnostics, `${path}.run`, refsFromScope(ctx));
      const agentKey = isRecord(node.run) && typeof node.run.agent === "string" ? node.run.agent : undefined;
      if (agentKey && !ctx.agents.has(agentKey)) {
        diagnostics.push({
          code: "A001",
          severity: "error",
          message: `Agent node '${node.id}' references undeclared agent '${agentKey}'.`,
          path: `${path}.run.agent`,
          hint: "Declare the agent under defineWorkflow({ agents }) and reference it with agents.<key>.",
        });
      }
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "task": {
      validateKnownFields(node, ["id", "kind", "run", "timeout"], diagnostics, path);
      validateDurationExpr(node.timeout, diagnostics, `${path}.timeout`, `Task node '${node.id}' timeout`, "IR002", refsFromScope(ctx));
      validateTaskRun(node.run, diagnostics, `${path}.run`, refsFromScope(ctx));
      break;
    }
    case "signal": {
      validateKnownFields(node, ["id", "kind", "outputSchema", "run", "timeout", "onTimeout"], diagnostics, path);
      validateDurationExpr(node.timeout, diagnostics, `${path}.timeout`, `Signal node '${node.id}' timeout`, "IR002", refsFromScope(ctx));
      if (node.onTimeout !== undefined && node.timeout === undefined) addError(diagnostics, "S001", `Signal node '${node.id}' onTimeout requires timeout.`, `${path}.onTimeout`);
      validateSignalRun(node.run, diagnostics, `${path}.run`, refsFromScope(ctx));
      validateSignalTimeout(node.onTimeout, diagnostics, `${path}.onTimeout`, node.id, refsFromScope(ctx));
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "assert": {
      validateKnownFields(node, ["id", "kind", "condition", "message"], diagnostics, path);
      validateExpr(node.condition, diagnostics, `${path}.condition`, refsFromScope(ctx));
      if (node.message !== undefined) validateStringExpr(node.message, diagnostics, `${path}.message`, "Assert message", "IR002", refsFromScope(ctx));
      break;
    }
    case "if": {
      validateKnownFields(node, ["id", "kind", "condition", "then", "else"], diagnostics, path);
      validateExpr(node.condition, diagnostics, `${path}.condition`, refsFromScope(ctx));
      validateScope(node.then, diagnostics, childScopeContext(ctx, `${path}.then`));
      if (!node.else) {
        diagnostics.push({
          code: "G002",
          severity: "error",
          message: `If node '${node.id}' must declare else.`,
          path: `${path}.else`,
          hint: "Add an else branch. Use else() { return {}; } for control-only branching.",
        });
      } else {
        validateScope(node.else, diagnostics, childScopeContext(ctx, `${path}.else`));
      }
      break;
    }
    case "switch": {
      validateKnownFields(node, ["id", "kind", "cases", "default"], diagnostics, path);
      if (!Array.isArray(node.cases)) {
        addError(diagnostics, "IR002", "Switch cases must be an array.", `${path}.cases`);
      } else {
        forEachDense(node.cases, diagnostics, `${path}.cases`, (c, i) => {
          const casePath = `${path}.cases.${i}`;
          if (!requireRecord(c, diagnostics, casePath, "IR002", "Switch case must be an object.")) return;
          validateKnownFields(c, ["when", "then"], diagnostics, casePath);
          validateExpr(c.when, diagnostics, `${casePath}.when`, refsFromScope(ctx));
          validateScope(c.then, diagnostics, childScopeContext(ctx, `${casePath}.then`));
        }, { code: "IR002" });
      }
      if (!node.default) {
        diagnostics.push({
          code: "G003",
          severity: "error",
          message: `Switch node '${node.id}' must declare default.`,
          path: `${path}.default`,
          hint: "Add a default branch. Use default() { return {}; } for control-only routing.",
        });
      } else {
        validateScope(node.default, diagnostics, childScopeContext(ctx, `${path}.default`));
      }
      break;
    }
    case "parallel": {
      validateKnownFields(node, ["id", "kind", "branches", "strategy", "maxConcurrency"], diagnostics, path);
      if (node.strategy !== "all" && node.strategy !== "race") addError(diagnostics, "P001", `Parallel node '${node.id}' strategy must be 'all' or 'race'.`, `${path}.strategy`);
      validateConcurrencyExpr(node.maxConcurrency, diagnostics, `${path}.maxConcurrency`, `Parallel node '${node.id}' maxConcurrency`, "P001", refsFromScope(ctx));
      if (!isRecord(node.branches)) {
        addError(diagnostics, "IR002", "Parallel branches must be an object.", `${path}.branches`);
        break;
      }
      if (node.strategy === "race" && Object.keys(node.branches).length === 0) addError(diagnostics, "P002", `Parallel race node '${node.id}' must declare at least one branch.`, `${path}.branches`);
      for (const [name, scope] of Object.entries(node.branches)) {
        const branchPath = `${path}.branches.${name}`;
        validateScope(scope, diagnostics, childScopeContext(ctx, branchPath));
      }
      break;
    }
    case "fanout": {
      validateKnownFields(node, ["id", "kind", "over", "do", "maxConcurrency", "strategy", "count"], diagnostics, path);
      const strategy = (node as { strategy?: string }).strategy;
      const count = (node as { count?: unknown }).count;
      if (strategy !== "all" && strategy !== "quorum") addError(diagnostics, "F001", `Fanout node '${node.id}' strategy must be 'all' or 'quorum'.`, `${path}.strategy`);
      if (strategy === "quorum" && count === undefined) addError(diagnostics, "F002", `Fanout node '${node.id}' quorum count is required.`, `${path}.count`);
      if (strategy === "quorum" && count !== undefined) validateIntegerExpr(count, diagnostics, `${path}.count`, `Fanout node '${node.id}' quorum count`, "F002", refsFromScope(ctx), 1);
      if (strategy !== "quorum" && count !== undefined) addError(diagnostics, "F003", `Fanout node '${node.id}' count is only valid with quorum strategy.`, `${path}.count`);
      validateConcurrencyExpr(node.maxConcurrency, diagnostics, `${path}.maxConcurrency`, `Fanout node '${node.id}' maxConcurrency`, "F001", refsFromScope(ctx));
      const validOver = validateExpr(node.over, diagnostics, `${path}.over`, refsFromScope(ctx));
      if (validOver) validateFanoutOver(node.over, diagnostics, `${path}.over`);
      validateScope(node.do, diagnostics, childScopeContext(ctx, `${path}.do`, { fanoutId: id }));
      break;
    }
    case "loop": {
      validateKnownFields(node, ["id", "kind", "state", "do"], diagnostics, path);
      validateExpr(node.state, diagnostics, `${path}.state`, refsFromScope(ctx));
      validateScope(node.do, diagnostics, childScopeContext(ctx, `${path}.do`, { loopId: id }));
      validateLoopTransitionScope(node.do, diagnostics, `${path}.do`);
      break;
    }
    default:
      addError(diagnostics, "N001", `Unknown node kind '${String((node as { kind?: unknown }).kind)}'.`, `${path}.kind`);
  }
}

function validateAgentRun(run: unknown, diagnostics: DiagnosticIR[], path: string, refs: RefContext): void {
  if (!requireRecord(run, diagnostics, path, "A003", "Agent run must be an object.")) return;
  validateKnownFields(run, ["agent", "prompt", "permissionMode", "sessionKey", "cwd", "env"], diagnostics, path);
  validateRequiredNonEmptyString(run.agent, diagnostics, `${path}.agent`, "A003", "Agent run agent must be a non-empty string.");
  validateStringExpr(run.prompt, diagnostics, `${path}.prompt`, "Agent prompt", "A003", refs);
  validatePermissionMode(run.permissionMode, diagnostics, `${path}.permissionMode`);
  if (run.sessionKey !== undefined) validateStringExpr(run.sessionKey, diagnostics, `${path}.sessionKey`, "Agent sessionKey", "A003", refs);
  if (run.cwd !== undefined) validateStringExpr(run.cwd, diagnostics, `${path}.cwd`, "Agent cwd", "A003", refs);
  validateDynamicEnv(run.env, diagnostics, `${path}.env`, refs);
}

function validatePermissionMode(value: unknown, diagnostics: DiagnosticIR[], path: string): void {
  validateOptionalEnum(value, ["approve-reads", "approve-all", "deny-all"], diagnostics, path, "A002", "Agent permissionMode must be approve-reads, approve-all, or deny-all.");
}

function validateAgentMode(value: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    addError(diagnostics, "A002", "Agent agentMode must be a non-empty string.", path);
  }
}

function validateAgentTrace(value: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    addError(diagnostics, "A002", "Agent trace must be a boolean.", path);
  }
}

function validateTaskRun(run: unknown, diagnostics: DiagnosticIR[], path: string, refs: RefContext): void {
  if (!requireRecord(run, diagnostics, path, "T007", "Task run must be an object.")) return;
  validateKnownFields(run, ["input", "target", "cwd", "env", "execution"], diagnostics, path);
  validateExprObject(run.input, diagnostics, `${path}.input`, refs);
  validateTaskTarget(run.target, diagnostics, `${path}.target`);
  if (run.cwd !== undefined) validateStringExpr(run.cwd, diagnostics, `${path}.cwd`, "Task cwd", "T007", refs);
  validateDynamicEnv(run.env, diagnostics, `${path}.env`, refs);
  validateTaskExecution(run.execution, diagnostics, `${path}.execution`, refs);
}

function validateTaskTarget(target: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!requireRecord(target, diagnostics, path, "T007", "Task run target must be an object.")) return;
  if (target.kind === "inline") {
    validateKnownFields(target, ["kind", "source"], diagnostics, path);
    validateRequiredNonEmptyString(target.source, diagnostics, `${path}.source`, "T007", "Inline task target source must be a non-empty string.");
    return;
  }
  if (target.kind === "module") {
    validateKnownFields(target, ["kind", "specifier", "exportName", "referrer"], diagnostics, path);
    validateRequiredNonEmptyString(target.specifier, diagnostics, `${path}.specifier`, "T007", "Module task target specifier must be a non-empty string.");
    validateRequiredNonEmptyString(target.exportName, diagnostics, `${path}.exportName`, "T007", "Module task target exportName must be a non-empty string.");
    validateTaskReferrer(target.referrer, diagnostics, `${path}.referrer`);
    return;
  }
  addError(diagnostics, "T007", "Task run target kind must be inline or module.", `${path}.kind`);
}

function validateTaskReferrer(referrer: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!requireRecord(referrer, diagnostics, path, "T007", "Module task target referrer must be an object.")) return;
  validateKnownFields(referrer, ["path"], diagnostics, path);
  if (typeof referrer.path !== "string" || referrer.path.length === 0) {
    addError(diagnostics, "T007", "Module task target referrer path must be a non-empty string.", `${path}.path`);
  } else if (referrer.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(referrer.path)) {
    addError(diagnostics, "T007", "Module task target referrer path must be workspace-relative.", `${path}.path`);
  } else if (referrer.path.split(/[\\/]/).includes("..")) {
    addError(diagnostics, "T007", "Module task target referrer path must stay inside the workspace.", `${path}.path`);
  }
}

function validateSignalRun(run: unknown, diagnostics: DiagnosticIR[], path: string, refs: RefContext): void {
  if (!requireRecord(run, diagnostics, path, "S002", "Signal run must be an object.")) return;
  validateKnownFields(run, ["prompt"], diagnostics, path);
  validateStringExpr(run.prompt, diagnostics, `${path}.prompt`, "Signal prompt", "S002", refs);
}

function validateSignalTimeout(onTimeout: unknown, diagnostics: DiagnosticIR[], path: string, id: string, refs: RefContext): void {
  if (onTimeout === undefined) return;
  if (!requireRecord(onTimeout, diagnostics, path, "S001", `Signal node '${id}' onTimeout must be an object.`)) return;
  validateKnownFields(onTimeout, ["message"], diagnostics, path);
  if (onTimeout.message !== undefined) validateStringExpr(onTimeout.message, diagnostics, `${path}.message`, `Signal node '${id}' onTimeout message`, "S001", refs);
}

function validateFanoutOver(expr: ExprIR, diagnostics: DiagnosticIR[], path: string): void {
  if (expr.kind === "literal" && !Array.isArray(expr.value)) {
    addError(diagnostics, "F004", "Fanout over literal must be an array.", path);
  }
  if (expr.kind === "object") {
    addError(diagnostics, "F004", "Fanout over object expression must be an array value.", path);
  }
}

function validateExprObject(values: unknown, diagnostics: DiagnosticIR[], path: string, refs?: RefContext): void {
  if (!values) {
    addError(diagnostics, "E000", "Expression object is required.", path);
    return;
  }
  if (!requireRecord(values, diagnostics, path, "E004", "Expression object fields must be an object.")) return;
  for (const [key, expr] of Object.entries(values)) validateExpr(expr, diagnostics, `${path}.${key}`, refs);
}

function validateDynamicEnv(values: unknown, diagnostics: DiagnosticIR[], path: string, refs?: RefContext): void {
  if (values === undefined) return;
  if (!requireRecord(values, diagnostics, path, "E004", "Env must be an object.")) return;
  for (const [key, value] of Object.entries(values)) validateStringExpr(value, diagnostics, `${path}.${key}`, `Env '${key}'`, "E004", refs);
}

function validateStaticEnv(values: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (values === undefined) return;
  if (!requireRecord(values, diagnostics, path, "E004", "Env must be an object.")) return;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") addError(diagnostics, "E004", `Env '${key}' must be a string.`, `${path}.${key}`);
  }
}

function validateTaskExecution(execution: unknown, diagnostics: DiagnosticIR[], path: string, refs: RefContext): void {
  if (execution === undefined) return;
  if (!requireRecord(execution, diagnostics, path, "T006", "Task execution must be an object.")) return;
  validateKnownFields(execution, ["defaultCommandTimeout"], diagnostics, path);
  validateDurationExpr(execution.defaultCommandTimeout, diagnostics, `${path}.defaultCommandTimeout`, "Task defaultCommandTimeout", "T006", refs);
}

function validateExpr(expr: unknown, diagnostics: DiagnosticIR[], path: string, refs?: RefContext): expr is ExprIR {
  if (expr === undefined || expr === null) {
    addError(diagnostics, "E000", "Expression is required.", path);
    return false;
  }
  if (!isRecord(expr) || typeof expr.kind !== "string") {
    addError(diagnostics, "E004", "Expression must be an object with kind.", path);
    return false;
  }
  if (expr.kind === "literal" && !Object.prototype.hasOwnProperty.call(expr, "value")) {
    addError(diagnostics, "E003", "Expression literal must include value.", `${path}.value`);
    return true;
  }
  const issues = validateExprIR(expr);
  diagnostics.push(...issues.map(issue => expressionDiagnostic(issue, path)));
  if (issues.length === 0 && refs) validateExprRefs(expr as ExprIR, diagnostics, path, refs);
  return issues.length === 0;
}

function validateStringExpr(
  value: unknown,
  diagnostics: DiagnosticIR[],
  path: string,
  label: string,
  code: DiagnosticIR["code"],
  refs?: RefContext,
): void {
  if (!validateExpr(value, diagnostics, path, refs)) return;
  if (value.kind === "literal" && typeof value.value !== "string") {
    addError(diagnostics, code, `${label} must resolve to a string.`, path);
  }
}

function validateDurationExpr(
  value: unknown,
  diagnostics: DiagnosticIR[],
  path: string,
  label: string,
  code: DiagnosticIR["code"],
  refs: RefContext,
): void {
  if (value === undefined || !validateExpr(value, diagnostics, path, refs)) return;
  if (value.kind === "literal" && (typeof value.value !== "string" || tryParseDurationMs(value.value).isErr())) {
    addError(diagnostics, code, `${label} must resolve to a duration string like 500ms, 30s, 5m, 1h, or 1000.`, path);
  }
}

function validateIntegerExpr(
  value: unknown,
  diagnostics: DiagnosticIR[],
  path: string,
  label: string,
  code: DiagnosticIR["code"],
  refs: RefContext,
  minimum: number,
): void {
  if (value === undefined || !validateExpr(value, diagnostics, path, refs)) return;
  const invalid = value.kind === "literal" && (minimum === 1
    ? !isPositiveInteger(value.value)
    : typeof value.value !== "number" || !Number.isInteger(value.value) || value.value < minimum);
  if (invalid) {
    addError(diagnostics, code, `${label} must resolve to an integer greater than or equal to ${minimum}.`, path);
  }
}

function validateConcurrencyExpr(
  value: unknown,
  diagnostics: DiagnosticIR[],
  path: string,
  label: string,
  code: DiagnosticIR["code"],
  refs: RefContext,
): void {
  if (value === undefined || !validateExpr(value, diagnostics, path, refs)) return;
  if (value.kind === "literal" && value.value !== 0 && !isPositiveInteger(value.value)) {
    addError(diagnostics, code, `${label} must resolve to 0 or a positive integer.`, path);
  }
}

function expressionDiagnostic(issue: ExpressionDiagnostic, basePath: string): DiagnosticIR {
  return {
    code: expressionCode(issue.code),
    severity: issue.severity,
    message: issue.message,
    path: expressionPath(basePath, issue.path),
  };
}

function expressionCode(code: ExpressionDiagnostic["code"]): DiagnosticIR["code"] {
  if (code === "EX006") return "E001";
  if (code === "EX001" || code === "EX003") return "E002";
  return "E004";
}

function expressionPath(basePath: string, path: string | undefined): string {
  if (!path || path === "$") return basePath;
  return `${basePath}${path.slice(1).replaceAll("[", ".").replaceAll("]", "")}`;
}

type RefContext = {
  visibleNodes: ReadonlySet<string>;
  fanoutIds: ReadonlySet<string>;
  loopIds: ReadonlySet<string>;
};

function refsFromScope(ctx: IrScopeContext): RefContext {
  return {
    visibleNodes: ctx.visibleNodes,
    fanoutIds: ctx.fanoutIds,
    loopIds: ctx.loopIds,
  };
}

function childScopeContext(
  ctx: IrScopeContext,
  path: string,
  options: { fanoutId?: string; loopId?: string } = {},
): IrScopeContext {
  const fanoutIds = new Set(ctx.fanoutIds);
  if (options.fanoutId) fanoutIds.add(options.fanoutId);
  const loopIds = new Set(ctx.loopIds);
  if (options.loopId) loopIds.add(options.loopId);
  return {
    ...ctx,
    path,
    visibleNodes: new Set(ctx.visibleNodes),
    fanoutIds,
    loopIds,
  };
}

function nodeId(node: unknown): string | undefined {
  return isRecord(node) && typeof node.id === "string" ? node.id : undefined;
}

function validateExprRefs(expr: ExprIR, diagnostics: DiagnosticIR[], path: string, refs: RefContext): void {
  switch (expr.kind) {
    case "ref":
      validateRefPath(expr.path, diagnostics, `${path}.path`, refs);
      return;
    case "call":
      expr.args.forEach((arg, index) => validateExprRefs(arg, diagnostics, `${path}.args.${index}`, refs));
      return;
    case "array":
      expr.items.forEach((item, index) => validateExprRefs(item, diagnostics, `${path}.items.${index}`, refs));
      return;
    case "object":
      for (const [key, value] of Object.entries(expr.fields)) validateExprRefs(value, diagnostics, `${path}.fields.${key}`, refs);
      return;
    case "template":
      validateTemplateRefs(expr, diagnostics, path, refs);
      return;
    case "literal":
      return;
  }
}

function validateTemplateRefs(template: TemplateIR, diagnostics: DiagnosticIR[], path: string, refs: RefContext): void {
  template.parts.forEach((part, index) => {
    if (part.kind === "expr") validateExprRefs(part.expr, diagnostics, `${path}.parts.${index}.expr`, refs);
  });
}

function validateRefPath(refPath: string[], diagnostics: DiagnosticIR[], path: string, refs: RefContext): void {
  const [root, id] = refPath;
  if (root === "nodes") {
    if (typeof id !== "string" || !refs.visibleNodes.has(id)) {
      addError(diagnostics, "IR003", `Node ref '${refPath.join(".")}' is not visible from this scope.`, path);
      return;
    }
    if (refPath[2] !== "output") {
      addError(diagnostics, "IR003", `Node ref '${refPath.join(".")}' is not visible from this scope.`, path);
    }
    return;
  }
  if (root === "fanout") {
    if (typeof id !== "string" || !refs.fanoutIds.has(id)) {
      addError(diagnostics, "IR003", `Fanout ref '${refPath.join(".")}' is not visible from this scope.`, path);
      return;
    }
    const member = refPath[2];
    if (member !== "item" && member !== "itemIndex") {
      addError(diagnostics, "IR003", `Fanout ref '${refPath.join(".")}' is not visible from this scope.`, path);
    }
    return;
  }
  if (root === "loop") {
    if (typeof id !== "string" || !refs.loopIds.has(id)) {
      addError(diagnostics, "IR003", `Loop ref '${refPath.join(".")}' is not visible from this scope.`, path);
      return;
    }
    const member = refPath[2];
    if (member !== "index" && member !== "round" && member !== "state") {
      addError(diagnostics, "IR003", `Loop ref '${refPath.join(".")}' is not visible from this scope.`, path);
    }
  }
}

function validateSchema(schema: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!schema) return;
  if (!isRecord(schema) || typeof schema.kind !== "string") {
    addError(diagnostics, "SC002", "Schema must be an object with kind.", path);
    return;
  }
  validateSchemaMetadata(schema, diagnostics, path);
  switch (schema.kind) {
    case "unknown":
    case "string":
    case "number":
    case "boolean":
    case "null":
      validateKnownFields(schema, ["kind", "description", "default", "optional", "nullable"], diagnostics, path);
      break;
    case "literal":
      validateKnownFields(schema, ["kind", "value", "description", "default", "optional", "nullable"], diagnostics, path);
      if (!Object.prototype.hasOwnProperty.call(schema, "value") || !isJsonPrimitive(schema.value)) addError(diagnostics, "SC002", "Literal schema value must be a JSON primitive.", `${path}.value`);
      break;
    case "enum":
      validateKnownFields(schema, ["kind", "values", "description", "default", "optional", "nullable"], diagnostics, path);
      if (!Array.isArray(schema.values)) {
        addError(diagnostics, "SC002", "Enum schema values must be an array.", `${path}.values`);
      } else {
        forEachDense(schema.values, diagnostics, `${path}.values`, (value, index) => {
          if (!isJsonPrimitive(value)) addError(diagnostics, "SC002", "Enum schema values must be JSON primitives.", `${path}.values.${index}`);
        });
      }
      break;
    case "object": {
      validateKnownFields(schema, ["kind", "fields", "required", "additionalProperties", "description", "default", "optional", "nullable"], diagnostics, path);
      if (!isRecord(schema.fields)) addError(diagnostics, "SC002", "Object schema fields must be an object.", `${path}.fields`);
      const fields = isRecord(schema.fields) ? schema.fields : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (!Array.isArray(schema.required)) addError(diagnostics, "SC002", "Object schema required must be an array.", `${path}.required`);
      else forEachDense(required, diagnostics, `${path}.required`, (req, index) => {
        if (typeof req !== "string" || !Object.hasOwn(fields, req)) addError(diagnostics, "SC001", `Required field '${String(req)}' is not present in object fields.`, `${path}.required.${index}`);
      });
      if (typeof schema.additionalProperties !== "boolean") addError(diagnostics, "SC002", "Object schema additionalProperties must be a boolean.", `${path}.additionalProperties`);
      for (const [key, field] of Object.entries(fields)) validateSchema(field as SchemaIR, diagnostics, `${path}.fields.${key}`);
      break;
    }
    case "array":
      validateKnownFields(schema, ["kind", "item", "description", "default", "optional", "nullable"], diagnostics, path);
      validateRequiredNestedSchema(schema.item, diagnostics, `${path}.item`);
      break;
    case "record":
      validateKnownFields(schema, ["kind", "value", "description", "default", "optional", "nullable"], diagnostics, path);
      validateRequiredNestedSchema(schema.value, diagnostics, `${path}.value`);
      break;
    case "union": {
      validateKnownFields(schema, ["kind", "variants", "description", "default", "optional", "nullable"], diagnostics, path);
      if (!Array.isArray(schema.variants)) {
        addError(diagnostics, "SC002", "Union schema variants must be an array.", `${path}.variants`);
        break;
      }
      forEachDense(schema.variants, diagnostics, `${path}.variants`, (variant, index) => validateSchema(variant as SchemaIR, diagnostics, `${path}.variants.${index}`));
      break;
    }
    default:
      addError(diagnostics, "SC002", `Unknown schema kind '${schema.kind}'.`, `${path}.kind`);
  }
}

function validateSchemaMetadata(schema: Record<string, unknown>, diagnostics: DiagnosticIR[], path: string): void {
  if (schema.description !== undefined && typeof schema.description !== "string") addError(diagnostics, "SC002", "Schema description must be a string.", `${path}.description`);
  if (schema.optional !== undefined && typeof schema.optional !== "boolean") addError(diagnostics, "SC002", "Schema optional must be a boolean.", `${path}.optional`);
  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") addError(diagnostics, "SC002", "Schema nullable must be a boolean.", `${path}.nullable`);
  if (schema.default !== undefined && !isJsonValue(schema.default)) addError(diagnostics, "SC002", "Schema default must be JSON-compatible.", `${path}.default`);
}

function validateRequiredNestedSchema(schema: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!schema) {
    addError(diagnostics, "SC002", "Nested schema is required.", path);
    return;
  }
  validateSchema(schema, diagnostics, path);
}

function addError(diagnostics: DiagnosticIR[], code: DiagnosticIR["code"], message: string, path?: string): void {
  diagnostics.push({ code, severity: "error", message, ...(path === undefined ? {} : { path }) });
}

function addWarning(diagnostics: DiagnosticIR[], code: DiagnosticIR["code"], message: string, path?: string): void {
  diagnostics.push({ code, severity: "warning", message, ...(path === undefined ? {} : { path }) });
}

function requireRecord(value: unknown, diagnostics: DiagnosticIR[], path: string, code: DiagnosticIR["code"], message: string): value is Record<string, unknown> {
  if (isRecord(value)) return true;
  addError(diagnostics, code, message, path);
  return false;
}

function requireArray<T>(value: unknown, diagnostics: DiagnosticIR[], path: string, code: DiagnosticIR["code"], message: string): T[] | undefined {
  if (Array.isArray(value)) return value as T[];
  addError(diagnostics, code, message, path);
  return undefined;
}

function validateRequiredNonEmptyString(value: unknown, diagnostics: DiagnosticIR[], path: string, code: DiagnosticIR["code"], message: string): void {
  if (typeof value !== "string" || value.length === 0) addError(diagnostics, code, message, path);
}

function validateRequiredEnum<T extends string>(value: unknown, allowed: readonly T[], diagnostics: DiagnosticIR[], path: string, code: DiagnosticIR["code"], message: string): void {
  if (!allowed.includes(value as T)) addError(diagnostics, code, message, path);
}

function validateOptionalEnum<T extends string>(value: unknown, allowed: readonly T[], diagnostics: DiagnosticIR[], path: string, code: DiagnosticIR["code"], message: string): void {
  if (value !== undefined) validateRequiredEnum(value, allowed, diagnostics, path, code, message);
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

function forEachDense<T>(
  items: T[],
  diagnostics: DiagnosticIR[],
  path: string,
  run: (item: T, index: number) => void,
  options: { code?: DiagnosticIR["code"]; message?: string } = {},
): void {
  for (let index = 0; index < items.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(items, index)) {
      diagnostics.push({ code: options.code ?? "SC002", severity: "error", message: options.message ?? "Array values must not contain sparse holes.", path: `${path}.${index}` });
      continue;
    }
    run(items[index]!, index);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isJsonPrimitive(value: unknown): value is null | string | number | boolean {
  return isJsonValue(value) && (value === null || typeof value !== "object");
}
