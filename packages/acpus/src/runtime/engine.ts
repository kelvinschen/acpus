import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JsonValue, NodeIR, ScopeIR, WorkflowIR } from "@acpus/core";
import { evalObjectExprs, renderTemplate, stableStringify, toJsonValue, type EvalNodeMap, type EvalRuntimeContext } from "./expr.js";
import { executeAgent, executeTask, RuntimeExecutionError, type ExecutionRuntime, type ExecutorResult } from "./executors.js";
import { parseSchemaIR, validationMessage } from "./schema.js";
import { digestText, now, RuntimeStore, runtimeId, type StoredRun } from "./store.js";

export type AdmitWorkflowOptions = {
  workflowPath?: string;
  preflightDir?: string;
  metadata?: JsonValue;
};

export type ExecuteOptions = {
  agentStub?: boolean;
};

export type ReplayResult = {
  ok: boolean;
  runId: string;
  computedOutput: JsonValue;
  recordedOutput?: JsonValue;
  message: string;
};

export type ForkOptions = {
  ir?: WorkflowIR;
  input?: JsonValue;
  metadata?: JsonValue;
};

type RunContext = {
  ir: WorkflowIR;
  input: JsonValue;
  nodes: EvalNodeMap;
  fanout: EvalRuntimeContext["fanout"];
  loop: EvalRuntimeContext["loop"];
  runtime: ExecutionRuntime;
};

class AwaitingSignalError extends Error {
  constructor(readonly nodeKey: string, readonly metadata: JsonValue) {
    super("Run is awaiting signal.");
  }
}

class PausedRunError extends Error {
  constructor() {
    super("Run is paused.");
  }
}

export class RuntimeEngine {
  readonly store: RuntimeStore;

  static open(workspaceDir: string): RuntimeEngine {
    return new RuntimeEngine(workspaceDir, RuntimeStore.open(workspaceDir));
  }

  constructor(readonly workspaceDir: string, store?: RuntimeStore) {
    this.store = store ?? RuntimeStore.open(workspaceDir);
  }

  async admitWorkflow(ir: WorkflowIR, rawInput: unknown, options: AdmitWorkflowOptions = {}): Promise<StoredRun> {
    const parsedInput = parseSchemaIR(ir.inputSchema, rawInput ?? {}, "input");
    if (!parsedInput.ok) {
      throw new RuntimeExecutionError("input_schema", `Workflow input is invalid: ${validationMessage(parsedInput.issues)}`, { issues: parsedInput.issues as unknown as JsonValue });
    }

    const runId = runtimeId("run");
    const runDir = join(this.workspaceDir, ".acpus", "runs", runId);
    const outputDir = join(runDir, "output");
    const bundleDir = join(runDir, "task-bundles");
    await mkdir(bundleDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const irJson = `${JSON.stringify(ir, null, 2)}\n`;
    const inputJson = `${JSON.stringify(parsedInput.value, null, 2)}\n`;
    await writeFile(join(runDir, "workflow.ir.json"), irJson);
    await writeFile(join(runDir, "input.json"), inputJson);
    await writeFile(join(runDir, "lock.json"), `${JSON.stringify({
      kind: "acpus_runtime_lock",
      version: 1,
      workflowPath: options.workflowPath ?? ir.lock.workflowSource ?? null,
      preflightDir: options.preflightDir ?? null,
      admittedAt: now(),
      metadata: options.metadata ?? null,
      irDigest: digestText(irJson),
      taskBundles: Object.fromEntries(Object.values(ir.assets.taskBundles).map(bundle => [bundle.id, { digest: bundle.digest, runtime: bundle.runtime }])),
    }, null, 2)}\n`);

    for (const bundle of Object.values(ir.assets.taskBundles)) {
      if (!bundle.source) throw new RuntimeExecutionError("task_bundle", `Task bundle '${bundle.id}' is missing source.`);
      await writeFile(join(bundleDir, `${bundle.id}.mjs`), bundle.source);
    }

    const taskBundleMetadata = toJsonValue(Object.fromEntries(Object.entries(ir.assets.taskBundles).map(([id, bundle]) => [id, {
      digest: bundle.digest,
      runtime: bundle.runtime,
      path: `task-bundles/${bundle.id}.mjs`,
      sourceFile: bundle.sourceFile ?? null,
      inline: bundle.inline ?? false,
    }])));
    const sourceGraphDigest = digestText([
      ir.lock.workflowSourceDigest ?? "",
      ...Object.values(ir.assets.taskBundles).map(bundle => bundle.digest).sort(),
    ].join("\n"));

    return this.store.admitRun({
      runId,
      workflowName: ir.name,
      input: parsedInput.value,
      ir,
      irDigest: digestText(irJson),
      sourceGraphDigest,
      lockMetadata: toJsonValue({ ...ir.lock, runtimeMetadata: options.metadata ?? null }),
      taskBundleMetadata,
      workspaceDir: this.workspaceDir,
      runDir,
    });
  }

  async execute(runId: string, options: ExecuteOptions = {}): Promise<StoredRun> {
    const admission = this.requireAdmission(runId);
    const run = this.requireRun(runId);
    if (run.status === "succeeded" || run.status === "cancelled") return run;
    if (run.status === "paused") return run;

    this.store.updateRunStatus(runId, "running");
    const context = this.createContext(admission.ir, admission.input, run.runDir, options);
    try {
      await this.executeScope(admission.ir.root, "root", context);
      const output = toJsonValue(evalObjectExprs(admission.ir.outputs, this.evalContext(context)));
      await writeFile(join(run.runDir, "output", "workflow.output.json"), `${JSON.stringify(output, null, 2)}\n`);
      this.store.completeRun(runId, output);
    } catch (error) {
      if (error instanceof AwaitingSignalError) {
        this.store.updateRunStatus(runId, "awaiting_signal", error.metadata);
      } else if (error instanceof PausedRunError) {
        this.store.updateRunStatus(runId, "paused");
      } else if (error instanceof RuntimeExecutionError && error.code === "cancelled") {
        this.store.failRun(runId, this.errorJson(error), "cancelled");
      } else {
        this.store.failRun(runId, this.errorJson(error));
      }
    }
    return this.requireRun(runId);
  }

  pauseRun(runId: string, idempotencyKey = randomUUID()): StoredRun {
    this.requireRun(runId);
    this.store.addCommand(runId, "pause", null, idempotencyKey);
    this.store.updateRunStatus(runId, "paused");
    return this.requireRun(runId);
  }

  async resumeRun(runId: string, options: ExecuteOptions = {}): Promise<StoredRun> {
    this.requireRun(runId);
    this.store.addCommand(runId, "resume");
    this.store.updateRunStatus(runId, "queued");
    return this.execute(runId, options);
  }

  async retryRun(runId: string, nodeKey?: string, options: ExecuteOptions = {}): Promise<StoredRun> {
    this.requireRun(runId);
    this.store.retry(runId, nodeKey);
    return this.execute(runId, options);
  }

  async signalRun(runId: string, nodeIdOrKey: string, payload: JsonValue, options: ExecuteOptions = {}): Promise<StoredRun> {
    this.requireRun(runId);
    const looksLikeKey = nodeIdOrKey.includes("/") || nodeIdOrKey.includes(":");
    this.store.addCommand(runId, "signal", toJsonValue({
      ...(looksLikeKey ? { nodeKey: nodeIdOrKey } : { nodeId: nodeIdOrKey }),
      payload,
    }));
    this.store.updateRunStatus(runId, "queued");
    return this.execute(runId, options);
  }

  replayRun(runId: string): ReplayResult {
    const run = this.requireRun(runId);
    const admission = this.requireAdmission(runId);
    const context = this.createContext(admission.ir, admission.input, run.runDir, { agentStub: false });
    for (const state of this.store.listNodeStates(runId)) {
      if (state.status === "succeeded" && state.output !== undefined) context.nodes[state.nodeId] = { output: state.output };
    }
    const computedOutput = toJsonValue(evalObjectExprs(admission.ir.outputs, this.evalContext(context)));
    const ok = stableStringify(computedOutput) === stableStringify(run.output ?? null);
    return {
      ok,
      runId,
      computedOutput,
      ...(run.output === undefined ? {} : { recordedOutput: run.output }),
      message: ok ? "Replay reached the recorded terminal output without side effects." : "Replay output differs from recorded terminal output.",
    };
  }

  async forkRun(sourceRunId: string, options: ForkOptions = {}): Promise<StoredRun> {
    const sourceRun = this.requireRun(sourceRunId);
    const sourceAdmission = this.requireAdmission(sourceRunId);
    const targetIr = options.ir ?? sourceAdmission.ir;
    const targetInput = options.input ?? sourceAdmission.input;
    const forked = await this.admitWorkflow(targetIr, targetInput, {
      metadata: toJsonValue({ forkedFrom: sourceRunId, ...(isObject(options.metadata) ? options.metadata : {}) }),
    });

    const sourceDigests = collectDefinitionDigests(sourceAdmission.ir.root);
    const targetDigests = collectDefinitionDigests(targetIr.root);
    const sourceArtifacts = this.store.listArtifacts(sourceRunId);
    const uriMap = new Map<string, string>();

    for (const state of this.store.listNodeStates(sourceRunId)) {
      if (state.status !== "succeeded" || state.output === undefined) continue;
      if (sourceDigests.get(state.nodeId) !== targetDigests.get(state.nodeId)) continue;
      for (const artifact of sourceArtifacts.filter(row => row.nodeKey === state.nodeKey)) {
        const artifactId = `art_${randomUUID()}`;
        const relativePath = join("artifacts", "inherited", `${artifactId}-${basename(artifact.relativePath)}`).replaceAll("\\", "/");
        const sourcePath = join(sourceRun.runDir, artifact.relativePath);
        const targetPath = join(forked.runDir, relativePath);
        await mkdir(dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath);
        const bytes = await readFile(targetPath);
        this.store.insertArtifact({
          artifactId,
          runId: forked.runId,
          nodeKey: state.nodeKey,
          nodeId: state.nodeId,
          attempt: state.attempt,
          mediaType: artifact.mediaType,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          size: bytes.byteLength,
          relativePath,
        });
        uriMap.set(`acpus://runs/${sourceRunId}/artifacts/${artifact.artifactId}`, `acpus://runs/${forked.runId}/artifacts/${artifactId}`);
      }
      this.store.setNodeState({
        runId: forked.runId,
        nodeKey: state.nodeKey,
        nodeId: state.nodeId,
        kind: state.kind,
        status: "succeeded",
        attempt: state.attempt,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        output: rewriteArtifactUris(state.output, uriMap),
        metadata: toJsonValue({ inheritedFrom: sourceRunId, sourceNodeKey: state.nodeKey }),
      });
    }

    this.store.appendEvent(forked.runId, "run.forked", { sourceRunId });
    return this.requireRun(forked.runId);
  }

  private async executeScope(scope: ScopeIR, scopeKey: string, context: RunContext): Promise<Record<string, unknown>> {
    for (const node of scope.nodes) {
      this.checkControl(context.runtime.runId);
      await this.executeNode(node, scopeKey, context);
    }
    return evalObjectExprs(scope.outputs ?? {}, this.evalContext(context));
  }

  private async executeNode(node: NodeIR, scopeKey: string, context: RunContext): Promise<JsonValue> {
    const key = nodeInstanceKey(scopeKey, node.id);
    const existing = this.store.getNodeState(context.runtime.runId, key);
    if (existing?.status === "succeeded" && existing.output !== undefined) {
      context.nodes[node.id] = { output: existing.output };
      return existing.output;
    }

    const attempt = (existing?.attempt ?? 0) + 1;
    this.store.setNodeState({
      runId: context.runtime.runId,
      nodeKey: key,
      nodeId: node.id,
      kind: node.kind,
      status: "running",
      attempt,
      startedAt: now(),
    });

    try {
      const result = await this.executeNodeFresh(node, key, attempt, context);
      const checkedOutput = this.validateCompositeOutput(node, result.output);
      context.nodes[node.id] = { output: checkedOutput };
      this.store.setNodeState({
        runId: context.runtime.runId,
        nodeKey: key,
        nodeId: node.id,
        kind: node.kind,
        status: "succeeded",
        attempt,
        startedAt: existing?.startedAt ?? now(),
        endedAt: now(),
        output: checkedOutput,
        metadata: result.metadata,
      });
      return checkedOutput;
    } catch (error) {
      if (error instanceof AwaitingSignalError) {
        this.store.setNodeState({
          runId: context.runtime.runId,
          nodeKey: key,
          nodeId: node.id,
          kind: node.kind,
          status: "awaiting_signal",
          attempt,
          startedAt: now(),
          metadata: error.metadata,
        });
        throw error;
      }
      if (!(error instanceof PausedRunError)) {
        this.store.setNodeState({
          runId: context.runtime.runId,
          nodeKey: key,
          nodeId: node.id,
          kind: node.kind,
          status: "failed",
          attempt,
          startedAt: now(),
          endedAt: now(),
          error: this.errorJson(error),
        });
      }
      throw error;
    }
  }

  private async executeNodeFresh(node: NodeIR, nodeKey: string, attempt: number, context: RunContext): Promise<ExecutorResult> {
    const evalContext = this.evalContext(context, node.id);
    const args = { nodeKey, attempt, evalContext, runtime: context.runtime };
    switch (node.kind) {
      case "task": return executeTask(node, args);
      case "agent": return executeAgent(node, context.ir, args);
      case "signal": return this.executeSignal(node, nodeKey, evalContext, context);
      case "assert": return this.executeAssert(node, evalContext);
      case "if": return this.executeIf(node, nodeKey, context);
      case "switch": return this.executeSwitch(node, nodeKey, context);
      case "parallel": return this.executeParallel(node, nodeKey, context);
      case "fanout": return this.executeFanout(node, nodeKey, context);
      case "loop": return this.executeLoop(node, nodeKey, context);
      default: throw new RuntimeExecutionError("node_kind", `Unsupported node kind ${(node as { kind?: unknown }).kind}.`);
    }
  }

  private executeSignal(node: Extract<NodeIR, { kind: "signal" }>, nodeKey: string, evalContext: EvalRuntimeContext, context: RunContext): ExecutorResult {
    const payload = this.store.takeSignalPayload(context.runtime.runId, node.id, nodeKey);
    const prompt = renderTemplate(node.run.prompt, evalContext);
    if (payload === undefined) {
      throw new AwaitingSignalError(nodeKey, toJsonValue({ nodeId: node.id, nodeKey, prompt }));
    }
    const parsed = parseSchemaIR(node.outputSchema, payload, `nodes.${node.id}.output`);
    if (!parsed.ok) throw new RuntimeExecutionError("signal_schema", `Signal '${node.id}' payload is invalid: ${validationMessage(parsed.issues)}`, { issues: parsed.issues as unknown as JsonValue });
    return { output: parsed.value, metadata: toJsonValue({ prompt, signaledAt: now() }) };
  }

  private executeAssert(node: Extract<NodeIR, { kind: "assert" }>, evalContext: EvalRuntimeContext): ExecutorResult {
    const passed = Boolean(evalObjectExprs({ condition: node.condition }, evalContext).condition);
    if (!passed) {
      const message = node.message ? renderTemplate(node.message, evalContext) : `Assertion '${node.id}' failed.`;
      throw new RuntimeExecutionError("assert_failed", message);
    }
    return { output: true, metadata: toJsonValue({ passed: true }) };
  }

  private async executeIf(node: Extract<NodeIR, { kind: "if" }>, nodeKey: string, context: RunContext): Promise<ExecutorResult> {
    const condition = Boolean(evalObjectExprs({ condition: node.condition }, this.evalContext(context)).condition);
    const selected = condition ? node.then : node.else;
    const output = selected ? await this.executeScope(selected, `${nodeKey}/${condition ? "then" : "else"}`, cloneContext(context)) : {};
    return { output: toJsonValue(output), metadata: toJsonValue({ selected: condition ? "then" : "else" }) };
  }

  private async executeSwitch(node: Extract<NodeIR, { kind: "switch" }>, nodeKey: string, context: RunContext): Promise<ExecutorResult> {
    for (let index = 0; index < node.cases.length; index += 1) {
      const c = node.cases[index];
      if (!c) continue;
      const matched = Boolean(evalObjectExprs({ when: c.when }, this.evalContext(context)).when);
      if (matched) {
        const output = await this.executeScope(c.then, `${nodeKey}/case-${index}`, cloneContext(context));
        return { output: toJsonValue(output), metadata: toJsonValue({ selected: index }) };
      }
    }
    const output = node.default ? await this.executeScope(node.default, `${nodeKey}/default`, cloneContext(context)) : {};
    return { output: toJsonValue(output), metadata: toJsonValue({ selected: "default" }) };
  }

  private async executeParallel(node: Extract<NodeIR, { kind: "parallel" }>, nodeKey: string, context: RunContext): Promise<ExecutorResult> {
    const entries = Object.entries(node.branches);
    if (node.strategy === "race") {
      const raced = await Promise.race(entries.map(async ([name, branch]) => ({ name, output: await this.executeScope(branch.scope, `${nodeKey}/branch-${name}`, cloneContext(context)) })));
      return { output: toJsonValue({ [raced.name]: raced.output }), metadata: toJsonValue({ strategy: "race", winner: raced.name }) };
    }
    const results = await mapLimit(entries, node.maxConcurrency ?? entries.length || 1, async ([name, branch]) => {
      const output = await this.executeScope(branch.scope, `${nodeKey}/branch-${name}`, cloneContext(context));
      const parsed = parseSchemaIR(branch.outputSchema, output, `nodes.${node.id}.branches.${name}.output`);
      if (!parsed.ok) throw new RuntimeExecutionError("parallel_branch_schema", `Parallel branch '${name}' output is invalid: ${validationMessage(parsed.issues)}`, { issues: parsed.issues as unknown as JsonValue });
      return [name, parsed.value] as const;
    });
    return { output: toJsonValue(Object.fromEntries(results)), metadata: toJsonValue({ strategy: "all", branches: results.map(([name]) => name) }) };
  }

  private async executeFanout(node: Extract<NodeIR, { kind: "fanout" }>, nodeKey: string, context: RunContext): Promise<ExecutorResult> {
    const items = evalObjectExprs({ over: node.over }, this.evalContext(context)).over;
    if (!Array.isArray(items)) throw new RuntimeExecutionError("fanout_input", `Fanout '${node.id}' expected an array.`);
    const outputs = await mapLimit(items.map((item, itemIndex) => ({ item, itemIndex })), node.maxConcurrency ?? items.length || 1, async itemState => {
      const itemContext = cloneContext(context);
      itemContext.fanout[node.id] = { item: itemState.item, itemIndex: itemState.itemIndex };
      const key = node.key ? renderTemplate(node.key, this.evalContext(itemContext)) : String(itemState.itemIndex);
      const output = await this.executeScope(node.do, `${nodeKey}/item-${sanitizeKey(key)}`, itemContext);
      const parsed = parseSchemaIR(node.itemOutputSchema, output, `nodes.${node.id}.items[${itemState.itemIndex}]`);
      if (!parsed.ok) throw new RuntimeExecutionError("fanout_item_schema", `Fanout '${node.id}' item output is invalid: ${validationMessage(parsed.issues)}`, { issues: parsed.issues as unknown as JsonValue });
      return parsed.value;
    });
    if (node.strategy === "quorum") {
      const accepted = outputs.slice(0, node.count);
      return { output: toJsonValue({ accepted, completed: outputs }), metadata: toJsonValue({ strategy: "quorum", requested: node.count, completed: outputs.length }) };
    }
    return { output: toJsonValue(outputs), metadata: toJsonValue({ strategy: "all", completed: outputs.length }) };
  }

  private async executeLoop(node: Extract<NodeIR, { kind: "loop" }>, nodeKey: string, context: RunContext): Promise<ExecutorResult> {
    let previous: unknown;
    for (let iter = 0; iter < node.maxIterations; iter += 1) {
      const iterContext = cloneContext(context);
      iterContext.loop[node.id] = { iter, previous };
      const result = await this.executeScope(node.do, `${nodeKey}/iter-${iter}`, iterContext);
      const stopContext = cloneContext(iterContext);
      stopContext.loop[node.id] = { iter, previous, result };
      const parsed = parseSchemaIR(node.outputSchema, result, `nodes.${node.id}.iterations[${iter}]`);
      if (!parsed.ok) throw new RuntimeExecutionError("loop_output_schema", `Loop '${node.id}' output is invalid: ${validationMessage(parsed.issues)}`, { issues: parsed.issues as unknown as JsonValue });
      const stop = Boolean(evalObjectExprs({ stop: node.stopWhen }, this.evalContext(stopContext)).stop);
      if (stop) return { output: parsed.value, metadata: toJsonValue({ iterations: iter + 1, stopped: true }) };
      previous = parsed.value;
    }
    if (node.onExhausted === "returnLast" && previous !== undefined) return { output: toJsonValue(previous), metadata: toJsonValue({ iterations: node.maxIterations, exhausted: true }) };
    throw new RuntimeExecutionError("loop_exhausted", `Loop '${node.id}' exhausted ${node.maxIterations} iterations.`);
  }

  private validateCompositeOutput(node: NodeIR, output: JsonValue): JsonValue {
    const schema = "outputSchema" in node ? node.outputSchema : undefined;
    if (!schema || node.kind === "task" || node.kind === "agent" || node.kind === "signal") return output;
    const parsed = parseSchemaIR(schema, output, `nodes.${node.id}.output`);
    if (!parsed.ok) throw new RuntimeExecutionError("output_schema", `Node '${node.id}' output is invalid: ${validationMessage(parsed.issues)}`, { issues: parsed.issues as unknown as JsonValue });
    return parsed.value;
  }

  private createContext(ir: WorkflowIR, input: JsonValue, runDir: string, options: ExecuteOptions): RunContext {
    return {
      ir,
      input,
      nodes: {},
      fanout: {},
      loop: {},
      runtime: {
        store: this.store,
        workspaceDir: this.workspaceDir,
        runId: runtimeRunIdFromDir(runDir),
        runDir,
        outputDir: join(runDir, "output"),
        agentStub: options.agentStub ?? false,
      },
    };
  }

  private evalContext(context: RunContext, nodeId?: string): EvalRuntimeContext {
    return {
      input: context.input,
      nodes: context.nodes,
      runtime: {
        runId: context.runtime.runId,
        ...(nodeId ? { nodeId } : {}),
        workspaceDir: context.runtime.workspaceDir,
        outputDir: context.runtime.outputDir,
      },
      fanout: context.fanout,
      loop: context.loop,
    };
  }

  private checkControl(runId: string): void {
    const command = this.store.nextControlCommand(runId);
    if (!command) return;
    this.store.markCommandApplied(command.id);
    if (command.commandType === "pause") throw new PausedRunError();
    if (command.commandType === "cancel" || command.commandType === "shutdown") throw new RuntimeExecutionError("cancelled", `Run ${runId} was cancelled.`);
  }

  private requireRun(runId: string): StoredRun {
    const run = this.store.getRun(runId);
    if (!run) throw new RuntimeExecutionError("run_not_found", `Run '${runId}' was not found.`);
    return run;
  }

  private requireAdmission(runId: string) {
    const admission = this.store.getAdmission(runId);
    if (!admission) throw new RuntimeExecutionError("run_not_found", `Run admission '${runId}' was not found.`);
    return admission;
  }

  private errorJson(error: unknown): JsonValue {
    if (error instanceof RuntimeExecutionError) return toJsonValue({ code: error.code, message: error.message, details: error.details });
    return toJsonValue({ code: "internal", message: error instanceof Error ? error.message : String(error) });
  }
}

function nodeInstanceKey(scopeKey: string, nodeId: string): string {
  return scopeKey === "root" ? nodeId : `${scopeKey}/${nodeId}`;
}

function cloneContext(context: RunContext): RunContext {
  return {
    ...context,
    nodes: { ...context.nodes },
    fanout: { ...context.fanout },
    loop: { ...context.loop },
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function collectDefinitionDigests(scope: ScopeIR, out = new Map<string, string>()): Map<string, string> {
  for (const node of scope.nodes) {
    const shallow = { ...node } as Record<string, unknown>;
    if ("source" in shallow) delete shallow.source;
    out.set(node.id, `sha256:${createHash("sha256").update(stableStringify(shallow)).digest("hex")}`);
    if (node.kind === "if") {
      collectDefinitionDigests(node.then, out);
      if (node.else) collectDefinitionDigests(node.else, out);
    } else if (node.kind === "switch") {
      for (const c of node.cases) collectDefinitionDigests(c.then, out);
      if (node.default) collectDefinitionDigests(node.default, out);
    } else if (node.kind === "parallel") {
      for (const branch of Object.values(node.branches)) collectDefinitionDigests(branch.scope, out);
    } else if (node.kind === "fanout") {
      collectDefinitionDigests(node.do, out);
    } else if (node.kind === "loop") {
      collectDefinitionDigests(node.do, out);
    }
  }
  return out;
}

function rewriteArtifactUris(value: JsonValue, uriMap: Map<string, string>): JsonValue {
  if (Array.isArray(value)) return value.map(item => rewriteArtifactUris(item, uriMap));
  if (!isObject(value)) return value;
  const uri = typeof value.uri === "string" ? uriMap.get(value.uri) : undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) out[key] = rewriteArtifactUris(item, uriMap);
  if (uri) out.uri = uri;
  return out;
}

function runtimeRunIdFromDir(runDir: string): string {
  return basename(runDir);
}

function sanitizeKey(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
