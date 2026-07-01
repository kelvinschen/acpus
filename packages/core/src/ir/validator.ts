import { validateExprIR, type ExpressionDiagnostic } from "@acpus/expression/validator";
import type { DiagnosticIR, ExprIR, NodeIR, SchemaIR, SecretRefIR, TemplateIR, WorkflowIR } from "./types.js";

export function validateWorkflowIR(ir: WorkflowIR): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];
  if (!isRecord(ir)) {
    diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR must be an object.", path: "" });
    return diagnostics;
  }
  validateKnownFields(ir, ["irVersion", "name", "inputSchema", "agents", "root", "outputs", "lock", "diagnostics"], diagnostics, "");
  if (ir.irVersion !== 2) diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR irVersion must be 2.", path: "irVersion" });
  if (!ir.name || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(ir.name)) {
    diagnostics.push({ code: "W002", severity: "warning", message: `Workflow name '${ir.name}' is not identifier-like. This is allowed but discouraged.` });
  }
  validateSchema(ir.inputSchema, diagnostics, "inputSchema");
  const agents = isRecord(ir.agents) ? ir.agents : undefined;
  if (!agents) diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR agents must be an object.", path: "agents" });
  else validateAgents(agents, diagnostics);
  validateLock(ir.lock, diagnostics, "lock");
  validateDiagnostics(ir.diagnostics, diagnostics, "diagnostics");
  validateExprObject(ir.outputs, diagnostics, "outputs");
  const ids = new Set<string>();
  validateScope(ir.root, diagnostics, {
    path: "root",
    ids,
    agents: new Set(agents ? Object.keys(agents) : []),
  });
  return diagnostics;
}

function validateLock(lock: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(lock)) {
    diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR lock must be an object.", path });
    return;
  }
  validateKnownFields(lock, ["acpusCoreVersion", "workflowSource", "workflowSourceDigest", "generatedAt", "notes"], diagnostics, path);
  if (typeof lock.acpusCoreVersion !== "string" || lock.acpusCoreVersion.length === 0) diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR lock acpusCoreVersion must be a non-empty string.", path: `${path}.acpusCoreVersion` });
  if (typeof lock.generatedAt !== "string" || lock.generatedAt.length === 0) diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR lock generatedAt must be a non-empty string.", path: `${path}.generatedAt` });
  if (!Array.isArray(lock.notes)) {
    diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR lock notes must be an array.", path: `${path}.notes` });
  } else {
    forEachDense(lock.notes, diagnostics, `${path}.notes`, (note, index) => {
      if (typeof note !== "string") diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR lock notes must be a string array.", path: `${path}.notes.${index}` });
    }, { code: "IR002" });
  }
}

function validateDiagnostics(value: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!Array.isArray(value)) {
    diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR diagnostics must be an array.", path });
    return;
  }
  forEachDense(value, diagnostics, path, (diagnostic, index) => {
    if (!isRecord(diagnostic)) {
      diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR diagnostic entries must be objects.", path: `${path}.${index}` });
      return;
    }
    validateKnownFields(diagnostic, ["code", "severity", "message", "path", "source", "hint"], diagnostics, `${path}.${index}`);
    if (typeof diagnostic.code !== "string" || diagnostic.code.length === 0) diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR diagnostic code must be a non-empty string.", path: `${path}.${index}.code` });
    if (diagnostic.severity !== "error" && diagnostic.severity !== "warning" && diagnostic.severity !== "info") diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR diagnostic severity must be error, warning, or info.", path: `${path}.${index}.severity` });
    if (typeof diagnostic.message !== "string" || diagnostic.message.length === 0) diagnostics.push({ code: "IR002", severity: "error", message: "WorkflowIR diagnostic message must be a non-empty string.", path: `${path}.${index}.message` });
  }, { code: "IR002" });
}

function validateAgents(agents: WorkflowIR["agents"], diagnostics: DiagnosticIR[]): void {
  for (const [name, agent] of Object.entries(agents)) {
    const path = `agents.${name}`;
    if (!isRecord(agent)) {
      diagnostics.push({ code: "A002", severity: "error", message: `Agent '${name}' definition must be an object.`, path });
      continue;
    }
    if (agent.kind === "agent_definition") {
      validateKnownFields(agent, ["kind", "use", "model", "permissionMode", "agentMode", "cwd", "env"], diagnostics, path);
      if (typeof (agent as { use?: unknown }).use !== "string" || agent.use.length === 0) {
        diagnostics.push({ code: "A002", severity: "error", message: `Agent '${name}' use must be a non-empty string.`, path: `${path}.use` });
      }
      validatePermissionMode(agent.permissionMode, diagnostics, `${path}.permissionMode`);
      validateAgentMode(agent.agentMode, diagnostics, `${path}.agentMode`);
      if (agent.cwd) validateExpr(agent.cwd, diagnostics, `${path}.cwd`);
      validateEnv(agent.env, diagnostics, `${path}.env`);
      continue;
    }

    if (agent.kind === "agent_command") {
      validateKnownFields(agent, ["kind", "command", "model", "permissionMode", "agentMode", "cwd", "env"], diagnostics, path);
      if (typeof (agent as { command?: unknown }).command !== "string" || agent.command.length === 0) {
        diagnostics.push({ code: "A002", severity: "error", message: `Command-backed agent '${name}' command must be a non-empty string.`, path: `${path}.command` });
      }
      validatePermissionMode(agent.permissionMode, diagnostics, `${path}.permissionMode`);
      validateAgentMode(agent.agentMode, diagnostics, `${path}.agentMode`);
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
};

function validateScope(scope: unknown, diagnostics: DiagnosticIR[], ctx: ScopeContext, expectedOutput?: unknown): void {
  if (!isRecord(scope)) {
    diagnostics.push({ code: "IR002", severity: "error", message: "Scope must be an object.", path: ctx.path });
    return;
  }
  validateKnownFields(scope, ["nodes", "outputs"], diagnostics, ctx.path);
  if (!Array.isArray(scope.nodes)) {
    diagnostics.push({ code: "IR002", severity: "error", message: "Scope nodes must be an array.", path: `${ctx.path}.nodes` });
    return;
  }
  forEachDense(scope.nodes, diagnostics, `${ctx.path}.nodes`, node => validateNode(node as NodeIR, diagnostics, ctx), { code: "IR002" });
  if (scope.outputs !== undefined) {
    validateExprObject(scope.outputs, diagnostics, `${ctx.path}.outputs`);
    validateScopeOutputFields(scope.outputs, expectedOutput, diagnostics, `${ctx.path}.outputs`);
  }
}

// A scope's lowered outputs MUST NOT declare fields outside the node's declared
// outputSchema. The authoring layer cannot reject excess keys at compile time
// because TypeScript does not apply excess-property checks to callback return
// values, so the closed output contract is enforced here at IR build time.
function validateScopeOutputFields(outputs: unknown, expectedOutput: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(outputs) || !isRecord(expectedOutput) || expectedOutput.kind !== "object") return;
  if (expectedOutput.additionalProperties === true) return;
  const declared = isRecord(expectedOutput.fields) ? expectedOutput.fields : {};
  for (const key of Object.keys(outputs)) {
    if (!(key in declared)) {
      diagnostics.push({
        code: "O001",
        severity: "error",
        message: `Output field '${key}' is not declared in the node outputSchema.`,
        path: `${path}.${key}`,
        hint: "Remove the returned field or add it to the node outputSchema.",
      });
    }
  }
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
      validateRetry(node.retry, diagnostics, `${path}.retry`, node.outputSchema !== undefined);
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
      validateKnownFields(node, ["id", "source", "kind", "outputSchema", "run", "timeout"], diagnostics, path);
      validateTaskRun(node.run, diagnostics, `${path}.run`);
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
      validateScope(node.then, diagnostics, { ...ctx, path: `${path}.then` }, node.outputSchema);
      if (node.else) validateScope(node.else, diagnostics, { ...ctx, path: `${path}.else` }, node.outputSchema);
      if (node.outputSchema && !node.else) {
        diagnostics.push({
          code: "G002",
          severity: "error",
          message: `If node '${node.id}' with outputSchema must declare else.`,
          path: `${path}.else`,
          hint: "Add an else branch that returns every outputSchema field, or remove outputSchema.",
        });
      }
      validateSchema(node.outputSchema, diagnostics, `${path}.outputSchema`);
      break;
    }
    case "switch": {
      validateKnownFields(node, ["id", "source", "kind", "cases", "default", "outputSchema"], diagnostics, path);
      if (!Array.isArray(node.cases)) {
        diagnostics.push({ code: "IR002", severity: "error", message: "Switch cases must be an array.", path: `${path}.cases` });
      } else {
        forEachDense(node.cases, diagnostics, `${path}.cases`, (c, i) => {
          const casePath = `${path}.cases.${i}`;
          if (!isRecord(c)) {
            diagnostics.push({ code: "IR002", severity: "error", message: "Switch case must be an object.", path: casePath });
            return;
          }
          validateKnownFields(c, ["when", "then"], diagnostics, casePath);
          validateExpr(c.when, diagnostics, `${casePath}.when`);
          validateScope(c.then, diagnostics, { ...ctx, path: `${casePath}.then` }, node.outputSchema);
        }, { code: "IR002" });
      }
      if (node.default) validateScope(node.default, diagnostics, { ...ctx, path: `${path}.default` }, node.outputSchema);
      if (node.outputSchema && !node.default) {
        diagnostics.push({
          code: "G003",
          severity: "error",
          message: `Switch node '${node.id}' with outputSchema must declare default.`,
          path: `${path}.default`,
          hint: "Add a default branch that returns every outputSchema field, or remove outputSchema.",
        });
      }
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
        validateScope(branch.scope, diagnostics, { ...ctx, path: `${branchPath}.scope` }, branch.outputSchema);
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
      validateScope(node.do, diagnostics, { ...ctx, path: `${path}.do` }, node.itemOutputSchema);
      break;
    }
    case "loop": {
      validateKnownFields(node, ["id", "source", "kind", "maxIterations", "do", "stopWhen", "onExhausted", "outputSchema"], diagnostics, path);
      if (!Number.isInteger(node.maxIterations) || node.maxIterations <= 0) diagnostics.push({ code: "L001", severity: "error", message: `Loop node '${node.id}' maxIterations must be a positive integer.`, path: `${path}.maxIterations` });
      if (node.onExhausted !== undefined && node.onExhausted !== "fail" && node.onExhausted !== "returnLast") diagnostics.push({ code: "L002", severity: "error", message: `Loop node '${node.id}' onExhausted must be 'fail' or 'returnLast'.`, path: `${path}.onExhausted` });
      validateExpr(node.stopWhen, diagnostics, `${path}.stopWhen`);
      validateScope(node.do, diagnostics, { ...ctx, path: `${path}.do` }, node.outputSchema);
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
  validateKnownFields(run, ["kind", "agent", "prompt", "permissionMode", "session", "cwd", "env"], diagnostics, path);
  if (run.kind !== "agent_run") diagnostics.push({ code: "A003", severity: "error", message: "Agent run kind must be agent_run.", path: `${path}.kind` });
  if (typeof run.agent !== "string" || run.agent.length === 0) diagnostics.push({ code: "A003", severity: "error", message: "Agent run agent must be a non-empty string.", path: `${path}.agent` });
  validateTemplate(run.prompt, diagnostics, `${path}.prompt`);
  validatePermissionMode(run.permissionMode, diagnostics, `${path}.permissionMode`);
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

function validatePermissionMode(value: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (value === undefined) return;
  if (value !== "approve-reads" && value !== "approve-all" && value !== "deny-all") {
    diagnostics.push({ code: "A002", severity: "error", message: "Agent permissionMode must be approve-reads, approve-all, or deny-all.", path });
  }
}

function validateAgentMode(value: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push({ code: "A002", severity: "error", message: "Agent agentMode must be a non-empty string.", path });
  }
}

function validateRetry(value: unknown, diagnostics: DiagnosticIR[], path: string, allowed: boolean): void {
  if (value === undefined) return;
  if (!allowed) {
    diagnostics.push({ code: "IR001", severity: "error", message: "Agent retry is only valid when outputSchema is declared.", path });
    return;
  }
  if (!isRecord(value)) {
    diagnostics.push({ code: "IR001", severity: "error", message: "Retry must be an object.", path });
    return;
  }
  validateKnownFields(value, ["max"], diagnostics, path);
  const max = (value as { max?: unknown }).max;
  if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max < 0)) {
    diagnostics.push({ code: "IR001", severity: "error", message: "Retry max must be a non-negative integer.", path: `${path}.max` });
  }
}

function validateTaskRun(run: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(run)) {
    diagnostics.push({ code: "T007", severity: "error", message: "Task run must be an object.", path });
    return;
  }
  validateKnownFields(run, ["kind", "input", "target", "cwd", "env", "execution"], diagnostics, path);
  if (run.kind !== "task_run") diagnostics.push({ code: "T007", severity: "error", message: "Task run kind must be task_run.", path: `${path}.kind` });
  validateExprObject(run.input, diagnostics, `${path}.input`);
  validateTaskTarget(run.target, diagnostics, `${path}.target`);
  if (run.cwd) validateExpr(run.cwd, diagnostics, `${path}.cwd`);
  validateEnv(run.env, diagnostics, `${path}.env`);
  validateTaskExecution(run.execution, diagnostics, `${path}.execution`);
}

function validateTaskTarget(target: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(target)) {
    diagnostics.push({ code: "T007", severity: "error", message: "Task run target must be an object.", path });
    return;
  }
  if (target.kind === "inline") {
    validateKnownFields(target, ["kind", "runtime", "source"], diagnostics, path);
    if (target.runtime !== "node") diagnostics.push({ code: "T007", severity: "error", message: "Inline task target runtime must be node.", path: `${path}.runtime` });
    if (typeof target.source !== "string" || target.source.length === 0) diagnostics.push({ code: "T007", severity: "error", message: "Inline task target source must be a non-empty string.", path: `${path}.source` });
    return;
  }
  if (target.kind === "module") {
    validateKnownFields(target, ["kind", "runtime", "specifier", "exportName", "referrer"], diagnostics, path);
    if (target.runtime !== "node") diagnostics.push({ code: "T007", severity: "error", message: "Module task target runtime must be node.", path: `${path}.runtime` });
    if (typeof target.specifier !== "string" || target.specifier.length === 0) diagnostics.push({ code: "T007", severity: "error", message: "Module task target specifier must be a non-empty string.", path: `${path}.specifier` });
    if (typeof target.exportName !== "string" || target.exportName.length === 0) diagnostics.push({ code: "T007", severity: "error", message: "Module task target exportName must be a non-empty string.", path: `${path}.exportName` });
    validateTaskReferrer(target.referrer, diagnostics, `${path}.referrer`);
    return;
  }
  diagnostics.push({ code: "T007", severity: "error", message: "Task run target kind must be inline or module.", path: `${path}.kind` });
}

function validateTaskReferrer(referrer: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!isRecord(referrer)) {
    diagnostics.push({ code: "T007", severity: "error", message: "Module task target referrer must be an object.", path });
    return;
  }
  validateKnownFields(referrer, ["kind", "path"], diagnostics, path);
  if (referrer.kind !== "workflow") diagnostics.push({ code: "T007", severity: "error", message: "Module task target referrer kind must be workflow.", path: `${path}.kind` });
  if (typeof referrer.path !== "string" || referrer.path.length === 0) {
    diagnostics.push({ code: "T007", severity: "error", message: "Module task target referrer path must be a non-empty string.", path: `${path}.path` });
  } else if (referrer.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(referrer.path)) {
    diagnostics.push({ code: "T007", severity: "error", message: "Module task target referrer path must be workspace-relative.", path: `${path}.path` });
  } else if (referrer.path.split(/[\\/]/).includes("..")) {
    diagnostics.push({ code: "T007", severity: "error", message: "Module task target referrer path must stay inside the workspace.", path: `${path}.path` });
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
  forEachDense(template.parts, diagnostics, `${path}.parts`, (part, index) => {
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
  }, { code: "TM002" });
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
  if (expr.kind === "literal" && !Object.prototype.hasOwnProperty.call(expr, "value")) {
    diagnostics.push({ code: "E003", severity: "error", message: "Expression literal must include value.", path: `${path}.value` });
    return true;
  }
  const issues = validateExprIR(expr);
  diagnostics.push(...issues.map(issue => expressionDiagnostic(issue, path)));
  return issues.length === 0;
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

function validateSchema(schema: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!schema) return;
  if (!isRecord(schema) || typeof schema.kind !== "string") {
    diagnostics.push({ code: "SC002", severity: "error", message: "Schema must be an object with kind.", path });
    return;
  }
  validateSchemaMetadata(schema, diagnostics, path);
  switch (schema.kind) {
    case "unknown":
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "path":
    case "secret_ref":
      validateKnownFields(schema, ["kind", "description", "default", "optional", "nullable"], diagnostics, path);
      break;
    case "artifact":
      validateKnownFields(schema, ["kind", "mediaType", "description", "default", "optional", "nullable"], diagnostics, path);
      if (schema.mediaType !== undefined && typeof schema.mediaType !== "string") diagnostics.push({ code: "SC002", severity: "error", message: "Artifact schema mediaType must be a string.", path: `${path}.mediaType` });
      break;
    case "literal":
      validateKnownFields(schema, ["kind", "value", "description", "default", "optional", "nullable"], diagnostics, path);
      if (!Object.prototype.hasOwnProperty.call(schema, "value") || !isJsonPrimitive(schema.value)) diagnostics.push({ code: "SC002", severity: "error", message: "Literal schema value must be a JSON primitive.", path: `${path}.value` });
      break;
    case "enum":
      validateKnownFields(schema, ["kind", "values", "description", "default", "optional", "nullable"], diagnostics, path);
      if (!Array.isArray(schema.values)) {
        diagnostics.push({ code: "SC002", severity: "error", message: "Enum schema values must be an array.", path: `${path}.values` });
      } else {
        forEachDense(schema.values, diagnostics, `${path}.values`, (value, index) => {
          if (!isJsonPrimitive(value)) diagnostics.push({ code: "SC002", severity: "error", message: "Enum schema values must be JSON primitives.", path: `${path}.values.${index}` });
        });
      }
      break;
    case "object": {
      validateKnownFields(schema, ["kind", "fields", "required", "additionalProperties", "description", "default", "optional", "nullable"], diagnostics, path);
      if (!isRecord(schema.fields)) diagnostics.push({ code: "SC002", severity: "error", message: "Object schema fields must be an object.", path: `${path}.fields` });
      const fields = isRecord(schema.fields) ? schema.fields : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (!Array.isArray(schema.required)) diagnostics.push({ code: "SC002", severity: "error", message: "Object schema required must be an array.", path: `${path}.required` });
      else forEachDense(required, diagnostics, `${path}.required`, (req, index) => {
        if (typeof req !== "string" || !(req in fields)) diagnostics.push({ code: "SC001", severity: "error", message: `Required field '${String(req)}' is not present in object fields.`, path: `${path}.required.${index}` });
      });
      if (typeof schema.additionalProperties !== "boolean") diagnostics.push({ code: "SC002", severity: "error", message: "Object schema additionalProperties must be a boolean.", path: `${path}.additionalProperties` });
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
        diagnostics.push({ code: "SC002", severity: "error", message: "Union schema variants must be an array.", path: `${path}.variants` });
        break;
      }
      forEachDense(schema.variants, diagnostics, `${path}.variants`, (variant, index) => validateSchema(variant as SchemaIR, diagnostics, `${path}.variants.${index}`));
      break;
    }
    case "integer":
      diagnostics.push({ code: "SC002", severity: "error", message: "SchemaIR must use kind 'number' instead of 'integer'.", path: `${path}.kind` });
      break;
    default:
      diagnostics.push({ code: "SC002", severity: "error", message: `Unknown schema kind '${schema.kind}'.`, path: `${path}.kind` });
  }
}

function validateSchemaMetadata(schema: Record<string, unknown>, diagnostics: DiagnosticIR[], path: string): void {
  if (schema.description !== undefined && typeof schema.description !== "string") diagnostics.push({ code: "SC002", severity: "error", message: "Schema description must be a string.", path: `${path}.description` });
  if (schema.optional !== undefined && typeof schema.optional !== "boolean") diagnostics.push({ code: "SC002", severity: "error", message: "Schema optional must be a boolean.", path: `${path}.optional` });
  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") diagnostics.push({ code: "SC002", severity: "error", message: "Schema nullable must be a boolean.", path: `${path}.nullable` });
  if (schema.default !== undefined && !isJsonValue(schema.default)) diagnostics.push({ code: "SC002", severity: "error", message: "Schema default must be JSON-compatible.", path: `${path}.default` });
}

function validateRequiredNestedSchema(schema: unknown, diagnostics: DiagnosticIR[], path: string): void {
  if (!schema) {
    diagnostics.push({ code: "SC002", severity: "error", message: "Nested schema is required.", path });
    return;
  }
  validateSchema(schema, diagnostics, path);
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

function isSecretRef(value: unknown): value is SecretRefIR {
  return isRecord(value) && value.kind === "secret";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isJsonPrimitive(value: unknown): value is null | string | number | boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (isJsonPrimitive(value)) return true;
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || !isJsonValue(value[index], seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const item of Object.values(value)) if (!isJsonValue(item, seen)) return false;
  seen.delete(value);
  return true;
}
