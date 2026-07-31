import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentDefinitionIR, AgentNodeIR, WorkflowIR } from "@acpus/core/ir";
import type { AgentBackendFailure, AgentTraceEvent, AgentTurnRequest, AgentTurnResult, AgentTurnSummary, AgentTurnTiming, ManagedAcpExecutor } from "@acpus/agent-executor";
import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import {
  removeRunFile,
  verifyRunFile,
  writeRunFile,
} from "../store/run-file.js";
import { isArtifactRefCandidate, tryBindArtifactRef, type ArtifactPathError } from "../artifacts/access.js";
import type { AgentHostPolicy } from "../configuration.js";
import { tryParsePersistedDeadline } from "../deadline.js";
import { type EvaluationScope } from "../evaluation/evaluator.js";
import { tryResolveString, type ResolutionError } from "../evaluation/resolvable.js";
import type { AgentObservationTurnEvidence } from "../observations/log.js";
import { createAgentProgressTurn, type AgentProgressTerminalStatus, type AgentProgressTurn } from "../progress/agent.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import { schedulerStoreError, throwSchedulerStoreResult } from "../scheduler/store-port.js";
import { pruneUndefined } from "../stable-json.js";
import {
  verifyRunDirectoryToken,
  type RunDirectoryToken,
} from "../store/path-fence.js";
import type { RuntimeStore } from "../store/store.js";
import {
  buildAgentOutputPrompt,
  buildAgentOutputRepairPrompt,
  conformAgentOutput,
  type AgentOutputProcessing,
} from "./agent-output.js";
import { resolveAgentSessionIdentity } from "./agent-session.js";

const CONTINUATION_PROMPT = "Continue the previous task from where you left off.";
const DEFAULT_REPAIR_DELAY_MS = 5_000;

export type AgentNodeFailure =
  | {
      origin: "provider";
      code: string;
      message: string;
      upstream?: AgentBackendFailure["upstream"];
    }
  | {
      origin: "runtime";
      code: "invalid_agent_response_repair_max" | "agent_acp_inactivity_stale" | "agent_acp_worker_lost";
      message: string;
      retryable?: boolean;
      evidence?: AgentBackendFailure["evidence"];
    };

export type AgentAttemptFailure =
  | { type: "resolution"; error: ResolutionError; message: string }
  | { type: "cancelled"; message: string }
  | { type: "timed_out"; failure: AgentNodeFailure; message: string }
  | { type: "failed"; failure: AgentNodeFailure; message: string };

export type AgentExecutorOptions = {
  cwd: string;
  runId?: string;
  agents: WorkflowIR["agents"];
  hostPolicy: AgentHostPolicy;
  nodeKey?: string;
  attemptId?: string;
  attemptNo?: number;
  ownerEpoch?: number;
  deadlineAt?: string;
  store?: RuntimeStore;
  progressWriter?: NodeProgressWriter;
  managedAcpExecutor?: ManagedAcpExecutor;
  initialPrompt?: AgentInitialPrompt;
  signal?: AbortSignal;
};

type AgentInitialPrompt =
  | { kind: "task" }
  | { kind: "continuation" }
  | { kind: "steer"; instruction: string };

type AgentTurnRecord = {
  turn: number;
  status: AgentTurnResult["status"];
  summary?: AgentTurnSummaryProjection;
  turnArtifact?: AgentArtifactRef;
  stderrArtifact?: AgentArtifactRef;
  traceArtifact?: AgentArtifactRef;
  outputProcessing?: AgentOutputProcessing;
  failure?: { kind: string; message: string; upstream?: AgentBackendFailure["upstream"] };
  message?: string;
};

export type AgentTurnArtifact = {
  schemaVersion: 1;
  runId: string;
  nodeId: string;
  nodeKey: string;
  attemptNo: number;
  turn: number;
  agentKey: string;
  sessionName: string;
  status: AgentTurnResult["status"];
  timing: AgentTurnTiming;
  prompt: string;
  response: string;
  summary: AgentTurnSummary;
  failure?: AgentBackendFailure;
  message?: string;
};

type AgentTraceRecordBase = {
  schemaVersion: 1;
  sequence: number;
  observedAt: string;
  elapsedMs: number;
};

type WithoutTraceBase<T> = T extends unknown ? Omit<T, keyof AgentTraceRecordBase> : never;

export type AgentTraceRecord = AgentTraceRecordBase & (
  | {
      type: "turn_start";
      runId: string;
      nodeId: string;
      nodeKey: string;
      attemptNo: number;
      turn: number;
      agentKey: string;
      sessionName: string;
      cwd: string;
      acpxRecordId?: string;
    }
  | WithoutTraceBase<AgentTraceEvent>
);

type AgentTurnSummaryProjection = Pick<AgentTurnSummary, "eventCount" | "availability" | "stopReason" | "context" | "tokenUsage"> & {
  tools: { totalToolCallCount: number };
  cwd?: string;
  acpxRecordId?: string;
};

type AgentArtifactRef = {
  artifactId: string;
  mediaType: string;
};

type ObservedAgentTurn = {
  result: AgentTurnResult;
  evidence?: AgentObservationTurnEvidence;
};

export function executeAgentNode(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): ResultAsync<JsonValue, AgentAttemptFailure> {
  return new ResultAsync(executeAgentNodeResult(node, scope, options));
}

async function executeAgentNodeResult(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Promise<Result<JsonValue, AgentAttemptFailure>> {
  const turns: AgentTurnRecord[] = [];
  const artifactRun = agentArtifactRun(options);
  let sessionNameForMetadata: string | undefined;
  let explicitSessionKey: string | undefined;
  let responseRepairMax: number | null | undefined;
  const progressWriter = options.progressWriter ?? options.store;
  const progressContext = progressWriter
    && options.runId
    && options.nodeKey
    && options.attemptId
    && options.ownerEpoch !== undefined
    ? {
        writer: progressWriter,
        runId: options.runId,
        nodeKey: options.nodeKey,
        nodeId: node.id,
        attemptId: options.attemptId,
        attemptNo: options.attemptNo ?? 1,
        ownerEpoch: options.ownerEpoch,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }
    : undefined;
  let activeProgress: AgentProgressTurn | undefined;
  const writeTerminalState = async (
    status: AgentProgressTerminalStatus,
    message?: string,
    result?: AgentTurnResult,
  ): Promise<void> => {
    if (result) activeProgress?.publishTerminal(status, result, message);
    await writeAgentAttemptMetadata(node, options, sessionNameForMetadata, explicitSessionKey, responseRepairMax, status, turns, message);
  };
  const finishFailure = async (
    failure: AgentAttemptFailure,
    result?: AgentTurnResult,
  ): Promise<Result<never, AgentAttemptFailure>> => {
    const status = failure.type === "cancelled" ? "cancelled" : failure.type === "timed_out" ? "timed_out" : "failed";
    try {
      await writeTerminalState(status, failure.message, result);
    } catch (metadataError) {
      throw new AggregateError([failure, metadataError], `Agent node '${node.id}' failed and its terminal metadata could not be persisted.`);
    }
    return err(failure);
  };

    const definition = options.agents[node.run.agent];
    if (!definition) throw new Error(`Agent '${node.run.agent}' is not declared.`);
    if (node.outputSchema) {
      if (options.hostPolicy.responseRepair.type === "invalid") {
        const failure: AgentNodeFailure = {
          origin: "runtime",
          code: "invalid_agent_response_repair_max",
          message: options.hostPolicy.responseRepair.failure.message,
        };
        responseRepairMax = null;
        return finishFailure({ type: "failed", failure, message: failure.message });
      }
      responseRepairMax = options.hostPolicy.responseRepair.max;
    } else {
      responseRepairMax = 0;
    }
    const cwd = node.run.cwd ? tryResolveString(node.run.cwd, scope, "agent cwd") : ok(definition.cwd ?? options.cwd);
    if (cwd.isErr()) return finishFailure(resolutionFailure(cwd.error));
    const dynamic = dynamicEnv(node.run.env, scope);
    if (dynamic.isErr()) return finishFailure(resolutionFailure(dynamic.error));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...staticEnv(definition.env),
      ...dynamic.value,
    };
    applyRuntimeAgentEnv(env, node.id, options);
    const deadline = options.deadlineAt === undefined ? undefined : persistedDeadline(options.deadlineAt, node.id);
    const session = resolveAgentSessionIdentity(node, scope, options.runId, options.nodeKey ?? node.id);
    if (session.isErr()) return finishFailure(resolutionFailure(session.error));
    explicitSessionKey = session.value.explicitSessionKey;
    sessionNameForMetadata = session.value.sessionName;
    const effectiveModel = definition.config?.model ?? definition.model;
    const runtimeObserved = Boolean(
      options.store
      && options.runId
      && options.nodeKey
      && options.attemptId
      && options.attemptNo !== undefined,
    );
    const turnBase = {
      agent: agentSelector(definition),
      cwd: cwd.value,
      env,
      sessionName: session.value.sessionName,
      permissionMode: node.run.permissionMode ?? definition.permissionMode ?? "approve-all",
      ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(definition.trace === true && !runtimeObserved ? { captureTrace: true } : {}),
    } satisfies Omit<AgentTurnRequest, "prompt" | "config">;
    const maxRepairTurns = responseRepairMax;
    const initialPrompt = options.initialPrompt ?? { kind: "task" };
    const resolvedPrompt = initialPrompt.kind === "task"
      ? renderAgentPrompt(node, scope, options)
      : ok(initialPrompt.kind === "steer"
        ? `<steering>${initialPrompt.instruction}</steering>`
        : CONTINUATION_PROMPT);
    if (resolvedPrompt.isErr()) return finishFailure(resolutionFailure(resolvedPrompt.error));
    const renderedPrompt = resolvedPrompt.value;
    let prompt = node.outputSchema
      ? buildAgentOutputPrompt(renderedPrompt, node.outputSchema)
      : renderedPrompt;
    const managedAcpExecutor = options.managedAcpExecutor ?? unavailableManagedAcpExecutor();
    return await managedAcpExecutor.withAttempt({
      runId: options.runId ?? `local-${node.id}`,
      attemptId: options.attemptId ?? `local-${node.id}`,
      sessionName: sessionNameForMetadata,
      cwd: cwd.value,
      env,
      agent: agentSelector(definition),
      permissionMode: turnBase.permissionMode,
      ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
      ...(options.hostPolicy.inactivityFailAfterMs === undefined ? {} : { inactivityFailAfterMs: options.hostPolicy.inactivityFailAfterMs }),
      onAcpActivity: observedAt => activeProgress?.recordAcpActivity(observedAt),
    }, async attempt => {
      for (let turn = 0; turn <= maxRepairTurns; turn += 1) {
      const remaining = remainingTimeout(deadline, node.id);
      if (remaining.isErr()) return finishFailure(remaining.error);
      activeProgress = progressContext
        ? createAgentProgressTurn({ ...progressContext, turn: turn + 1 })
        : undefined;
      const request = {
        ...turnBase,
        prompt,
        ...(remaining.value === undefined ? {} : { timeoutMs: remaining.value }),
        ...(turn === 0 && initialPrompt.kind === "task" && definition.config !== undefined ? { config: definition.config } : {}),
        ...(activeProgress?.callbacks ?? {}),
      } satisfies AgentTurnRequest;
      const observed = await executeObservedAgentTurn(
        node,
        options,
        turn + 1,
        turn === 0 ? initialPrompt.kind : "repair",
        definition.trace === true,
        request,
        attempt.runTurn,
      );
      const result = observed.result;
      activeProgress?.clearAcpActivity();
      if (options.signal?.aborted) {
        turns.push(agentTurnRecord(turn + 1, result));
        return finishFailure(abortedTurnFailure(result));
      }
      let turnRecord: AgentTurnRecord;
      try {
        turnRecord = await writeAgentTurnArtifacts(
          node,
          options,
          turn + 1,
          request,
          result,
          observed.evidence,
          artifactRun,
        );
      } catch (error) {
        if (!isAttemptFenceError(error)) throw error;
        turns.push(agentTurnRecord(turn + 1, result));
        return finishFailure({ type: "cancelled", message: "Agent turn was fenced." });
      }
      turns.push(turnRecord);
      if (options.signal?.aborted) return finishFailure(abortedTurnFailure(result));
      if (result.status === "cancelled") {
        return finishFailure({ type: "cancelled", message: result.message }, result);
      }
      if (result.status === "failed" && result.failure.kind === "timeout") {
        const failure = agentNodeFailure(result.failure);
        return finishFailure({ type: "timed_out", failure, message: failure.message }, result);
      }
      if (result.status === "failed") {
        const failure = agentNodeFailure(result.failure);
        return finishFailure({ type: "failed", failure, message: failure.message }, result);
      }
      if (!node.outputSchema) {
        await writeTerminalState("completed", undefined, result);
        return ok(result.responseText);
      }
      const conformed = conformAgentOutput(node.outputSchema, result.responseText, node.id);
      const outputProcessing = conformed.isOk() ? conformed.value.outputProcessing : conformed.error.outputProcessing;
      turns[turn] = { ...turns[turn]!, outputProcessing };
      if (conformed.isOk()) {
        await writeTerminalState("completed", undefined, result);
        return ok(conformed.value.output);
      }
      const rejected = conformed.error;
      turns[turn] = { ...turns[turn]!, failure: { kind: rejected.kind, message: rejected.message } };
      if (turn === maxRepairTurns) {
        const failure: AgentNodeFailure = { origin: "provider", code: rejected.kind, message: rejected.message };
        return finishFailure({ type: "failed", failure, message: failure.message }, result);
      }
      const delayed = await delay(DEFAULT_REPAIR_DELAY_MS, options.signal, deadline);
      if (delayed.isErr()) return finishFailure(delayed.error);
      prompt = buildAgentOutputRepairPrompt(node.outputSchema, rejected.phase);
      }
      throw new Error(`Agent node '${node.id}' exhausted response repair.`);
    });
}

async function executeObservedAgentTurn(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  turn: number,
  promptKind: "task" | "continuation" | "steer" | "repair",
  trace: boolean,
  request: AgentTurnRequest,
  runTurn: (request: AgentTurnRequest) => Promise<AgentTurnResult>,
): Promise<ObservedAgentTurn> {
  if (!options.store
    || !options.runId
    || !options.nodeKey
    || !options.attemptId
    || options.attemptNo === undefined) {
    return { result: await runTurn(request) };
  }
  const captured = await options.store.observationLog.captureTurn({
    runId: options.runId,
    nodeId: node.id,
    nodeKey: options.nodeKey,
    attemptId: options.attemptId,
    attemptNo: options.attemptNo,
    turn,
    promptKind,
    agentKey: node.run.agent,
    sessionName: request.sessionName,
    cwd: request.cwd,
    trace,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, request, runTurn);
  return captured;
}

function agentNodeFailure(failure: AgentBackendFailure): AgentNodeFailure {
  if (failure.kind === "inactivity_stale") {
    return {
      origin: "runtime",
      code: "agent_acp_inactivity_stale",
      message: failure.message,
      ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
      ...(failure.evidence === undefined ? {} : { evidence: failure.evidence }),
    };
  }
  if (failure.kind === "worker_lost") {
    return {
      origin: "runtime",
      code: "agent_acp_worker_lost",
      message: failure.message,
      ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
    };
  }
  return {
    origin: "provider",
    code: failure.kind,
    message: failure.message,
    ...(failure.upstream ? { upstream: failure.upstream } : {}),
  };
}

function unavailableManagedAcpExecutor(): ManagedAcpExecutor {
  return {
    withAttempt: async (_input, use) => use({
      runTurn: async () => ({
        status: "failed",
        failure: { kind: "worker_lost", origin: "runtime", message: "Agent execution requires a managed ACP executor." },
        responseText: "",
        stderr: "",
        summary: {
          eventCount: 0,
          availability: { context: "unavailable", tokenUsage: "unavailable" },
          tools: { totalToolCallCount: 0, calls: [] },
        },
        timing: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), elapsedMs: 0 },
      }),
    }),
    shutdown: async () => {},
  };
}

function resolutionFailure(error: ResolutionError): AgentAttemptFailure {
  return { type: "resolution", error, message: error.message };
}

function abortedTurnFailure(result: AgentTurnResult): AgentAttemptFailure {
  return {
    type: "cancelled",
    message: result.status === "cancelled" ? result.message : "Agent turn was aborted.",
  };
}

function isAttemptFenceError(error: unknown): boolean {
  const failure = schedulerStoreError(error);
  return failure?.type === "terminal-attempt"
    || failure?.type === "owner-epoch-stale"
    || failure?.type === "owner-epoch-inactive";
}

function renderAgentPrompt(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Result<string, ResolutionError> {
  const field = `Agent node '${node.id}' prompt`;
  try {
    return tryResolveString(node.run.prompt, scope, field, {
      formatTemplateValue: value => {
        if (!isArtifactRefCandidate(value)) return undefined;
        if (!options.store || !options.runId) throw new Error("Agent ArtifactRef interpolation requires runtime store and run id.");
        const resolved = tryBindArtifactRef(value, { cwd: options.cwd, runId: options.runId, store: options.store });
        if (resolved.isErr()) throw resolved.error;
        return resolved.value.path;
      },
    });
  } catch (error) {
    if (!isArtifactPathError(error)) throw error;
    return err({ type: "evaluation", field, message: error.message });
  }
}

function isArtifactPathError(error: unknown): error is ArtifactPathError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { type?: unknown; message?: unknown };
  return typeof candidate.message === "string"
    && (candidate.type === "invalid-artifact-ref"
      || candidate.type === "artifact-run-mismatch"
      || candidate.type === "artifact-not-found"
      || candidate.type === "artifact-path-invalid");
}

function applyRuntimeAgentEnv(env: NodeJS.ProcessEnv, nodeId: string, options: AgentExecutorOptions): void {
  env.ACPUS_RUNTIME_NODE_ID = nodeId;
  setOptionalEnv(env, "ACPUS_RUNTIME_RUN_ID", options.runId);
  setOptionalEnv(env, "ACPUS_RUNTIME_NODE_KEY", options.nodeKey);
  setOptionalEnv(env, "ACPUS_RUNTIME_ATTEMPT", options.attemptNo === undefined ? undefined : String(options.attemptNo));
}

function setOptionalEnv(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function dynamicEnv(env: AgentNodeIR["run"]["env"], scope: EvaluationScope): Result<Record<string, string>, ResolutionError> {
  if (!env) return ok({});
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const item = tryResolveString(value, scope, `Agent env '${key}'`);
    if (item.isErr()) return err(item.error);
    resolved[key] = item.value;
  }
  return ok(resolved);
}

function staticEnv(env: AgentDefinitionIR["env"]): Record<string, string> {
  return env ? { ...env } : {};
}

function agentSelector(definition: AgentDefinitionIR): AgentTurnRequest["agent"] {
  return definition.kind === "agent_command"
    ? { kind: "command", command: definition.command }
    : { kind: "named", name: definition.use };
}

async function writeAgentTurnArtifacts(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  turn: number,
  request: AgentTurnRequest,
  result: AgentTurnResult,
  evidence?: AgentObservationTurnEvidence,
  artifactRun?: RunDirectoryToken,
): Promise<AgentTurnRecord> {
  const base = agentTurnRecord(turn, result);
  if (!options.store || !options.runId) return base;
  const turnArtifact: AgentTurnArtifact = {
    schemaVersion: 1,
    runId: options.runId,
    nodeId: node.id,
    nodeKey: options.nodeKey ?? node.id,
    attemptNo: options.attemptNo ?? 1,
    turn,
    agentKey: node.run.agent,
    sessionName: request.sessionName,
    status: result.status,
    timing: result.timing,
    prompt: request.prompt,
    response: result.responseText,
    summary: result.summary,
    ...(result.status === "failed" ? { failure: result.failure } : {}),
    ...(result.status === "cancelled" ? { message: result.message } : {}),
  };
  const record: AgentTurnRecord = {
    ...base,
    turnArtifact: await writeAgentArtifact(options, artifactRun, turn, "json", `${JSON.stringify(turnArtifact, null, 2)}\n`, "application/json"),
    ...(result.stderr ? { stderrArtifact: await writeAgentArtifact(options, artifactRun, turn, "stderr.log", result.stderr, "text/plain") } : {}),
  };
  if (evidence?.trace) {
    record.traceArtifact = await publishAgentTraceArtifact(options, artifactRun, turn);
  }
  return record;
}

function agentTurnRecord(turn: number, result: AgentTurnResult): AgentTurnRecord {
  return {
    turn,
    status: result.status,
    summary: summaryProjection(result.summary),
    ...(result.status === "failed" ? { failure: result.failure } : {}),
    ...(result.status === "cancelled" ? { message: result.message } : {}),
  };
}

function summaryProjection(summary: AgentTurnSummary): AgentTurnSummaryProjection {
  return pruneUndefined({
    eventCount: summary.eventCount,
    availability: summary.availability,
    stopReason: summary.stopReason,
    context: summary.context,
    tokenUsage: summary.tokenUsage,
    tools: { totalToolCallCount: summary.tools.totalToolCallCount },
    cwd: summary.cwd,
    acpxRecordId: summary.acpxRecordId,
  }) as AgentTurnSummaryProjection;
}

async function writeAgentArtifact(
  options: AgentExecutorOptions,
  run: RunDirectoryToken | undefined,
  turn: number,
  name: string,
  content: string,
  mediaType: string,
): Promise<AgentArtifactRef> {
  if (!options.store || !options.runId) throw new Error("Agent artifact storage requires runtime store and run id.");
  if (!options.attemptId || options.ownerEpoch === undefined) throw new Error("Agent artifact storage requires scheduler attempt ownership.");
  if (!run) throw new Error("Agent artifact storage requires an opened run directory.");
  const nodeKey = options.nodeKey ?? "agent";
  const attempt = options.attemptNo ?? 1;
  const attemptDirectory = agentAttemptDirectory(attempt, options.attemptId);
  const id = `artifact_${randomUUID()}`;
  const relativePath = join("artifacts", nodeKey, attemptDirectory, "agent", `turn-${String(turn).padStart(3, "0")}.${name}`);
  const bytes = Buffer.from(content, "utf8");
  const label = `Agent artifact '${id}'`;
  const file = await writeRunFile({ run, relativePath, bytes, label });
  try {
    verifyRunFile(run, file, label);
    throwSchedulerStoreResult(options.store.registerArtifact({
      id,
      runId: options.runId,
      nodeKey,
      attemptId: options.attemptId,
      attempt,
      ownerEpoch: options.ownerEpoch,
      mediaType,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.byteLength,
      relativePath,
      file,
    }));
  } catch (error) {
    try {
      await removeRunFile(run, file, label);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Agent artifact '${id}' registration failed and its unregistered file could not be removed.`);
    }
    throw error;
  }
  verifyRunFile(run, file, label);
  return { artifactId: id, mediaType };
}

async function publishAgentTraceArtifact(
  options: AgentExecutorOptions,
  run: RunDirectoryToken | undefined,
  turn: number,
): Promise<AgentArtifactRef> {
  const { store, runId, attemptId, ownerEpoch } = options;
  if (!store || !runId) throw new Error("Agent trace publication requires runtime store and run id.");
  if (!attemptId || ownerEpoch === undefined) throw new Error("Agent trace publication requires scheduler attempt ownership.");
  if (!run) throw new Error("Agent trace publication requires an opened run directory.");
  verifyRunDirectoryToken(run);
  const nodeKey = options.nodeKey ?? "agent";
  const attempt = options.attemptNo ?? 1;
  const attemptDirectory = agentAttemptDirectory(attempt, attemptId);
  const artifactId = `artifact_${randomUUID()}`;
  const mediaType = "application/x-ndjson";
  const relativePath = join("artifacts", nodeKey, attemptDirectory, "agent", `turn-${String(turn).padStart(3, "0")}.trace.jsonl`);
  const published = await store.observationLog.publishTrace({
    runId,
    attemptId,
    turn,
    destinationRelativePath: relativePath,
    register: async trace => {
      verifyRunDirectoryToken(run);
      throwSchedulerStoreResult(store.registerArtifact({
        id: artifactId,
        runId,
        nodeKey,
        attemptId,
        attempt,
        ownerEpoch,
        mediaType,
        digest: trace.digest,
        size: trace.size,
        relativePath: trace.relativePath,
        file: trace.file,
      }));
    },
  });
  verifyRunDirectoryToken(run);
  if (!published) throw new Error(`Agent trace spool for turn ${turn} is missing.`);
  return { artifactId, mediaType };
}

function agentArtifactRun(options: AgentExecutorOptions): RunDirectoryToken | undefined {
  if (!options.store || !options.runId) return undefined;
  const run = options.store.getRunDirectoryToken(options.runId);
  if (!run) throw new Error(`Run '${options.runId}' has no run directory.`);
  return run;
}

function agentAttemptDirectory(attempt: number, attemptId: string): string {
  if (!/^attempt_[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(attemptId)) {
    throw new Error(`Agent artifact storage requires a scheduler-issued attempt id, received '${attemptId}'.`);
  }
  return join(`attempt-${attempt}`, attemptId);
}

async function writeAgentAttemptMetadata(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  sessionName: string | undefined,
  explicitSessionKey: string | undefined,
  responseRepairMax: number | null | undefined,
  status: "completed" | "failed" | "cancelled" | "timed_out",
  turns: AgentTurnRecord[],
  message?: string,
): Promise<void> {
  if (!options.store || !options.runId) return;
  options.store.writeExecutionMetadata({
    runId: options.runId,
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    kind: "agent_attempt",
    metadata: pruneUndefined({
      nodeId: node.id,
      nodeKey: options.nodeKey ?? node.id,
      attemptNo: options.attemptNo ?? 1,
      status,
      ...(sessionName ? { sessionName } : {}),
      ...(explicitSessionKey ? { sessionKey: explicitSessionKey } : {}),
      ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
      ...(responseRepairMax === undefined ? {} : { responseRepairMax }),
      turnCount: turns.length,
      turns: turns.map(turn => pruneUndefined(turn) as JsonValue),
      ...(message ? { message } : {}),
    }) as JsonValue,
  });
}

function delay(ms: number, signal: AbortSignal | undefined, deadline: number | undefined): Promise<Result<void, AgentAttemptFailure>> {
  if (ms <= 0) return Promise.resolve(ok(undefined));
  const remaining = remainingTimeout(deadline, "response repair");
  if (remaining.isErr()) return Promise.resolve(err(remaining.error));
  const delayMs = remaining.value === undefined ? ms : Math.min(ms, remaining.value);
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve(err({ type: "cancelled", message: "Agent response repair was aborted." }));
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      resolve(err({ type: "cancelled", message: "Agent response repair was aborted." }));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      if (remaining.value !== undefined && remaining.value <= ms) {
        resolve(err(timeoutFailure("Agent response repair timed out.")));
      } else {
        resolve(ok(undefined));
      }
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function remainingTimeout(deadline: number | undefined, nodeId: string): Result<number | undefined, AgentAttemptFailure> {
  if (deadline === undefined) return ok(undefined);
  const remaining = deadline - Date.now();
  return remaining <= 0
    ? err(timeoutFailure(`Agent node '${nodeId}' timed out.`))
    : ok(remaining);
}

function timeoutFailure(message: string): AgentAttemptFailure {
  return {
    type: "timed_out",
    failure: { origin: "provider", code: "timeout", message },
    message,
  };
}

function persistedDeadline(value: string, nodeId: string): number {
  const deadline = tryParsePersistedDeadline(value);
  if (deadline.isErr()) throw new Error(`Agent node '${nodeId}' has invalid persisted deadline ${JSON.stringify(value)}.`);
  return deadline.value.getTime();
}
