import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { JsonValue } from "@acpus/expression/ir";
import {
  applyAgentPresetChanges,
  hasPresetInjections,
  loadAgentPresetCatalog,
  type AgentPresetCatalog,
  type AgentPresetChange,
  type AgentPresetChoice,
  type AgentPresetScope,
  type InspectionForensicsView,
  type WritableAgentPresetScope,
} from "@acpus/runtime";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { AcpusOperationError, runtimePoolOperationError } from "./errors.js";
import {
  dshAgentPresetProvider,
  toAgentPresetSelectionView,
  toAgentPresetViews,
  type AgentPresetSelectionView,
} from "./agent-presets.js";
import {
  makeRuntimePool,
  type RuntimePool,
  type RuntimePoolOpenFailure,
} from "./runtime-pool.js";
import { createDshAgentLaunches } from "./dsh-agent.js";
import { RunLinkStore } from "./run-links.js";
import type { AdmittedRunLink, RunLink, StoredControl } from "./run-links.js";
import { ParentSessionAgentAdapter } from "./session-agent.js";
import { makeAcpusSupervision, type AcpusSupervision } from "./supervision.js";
import { findStoredActivityNode } from "./run-projection.js";
import {
  installAcpusPreset,
  type AcpusPresetInstallOptions,
} from "../preset/index.js";
import {
  normalizeAgentInjections,
  normalizeAuthoringInput,
  preflightAgentBindings,
  prepareAuthoringWorkflow,
  readAdmissionReceipt,
  submitPreparedWorkflow,
  type AcpusRunReceipt,
  type InvalidWorkflow,
} from "./submission.js";
import { abortError, AcpusProjectionReader } from "../remote/reader.js";
import type {
  AwaitSessionActivityRevisionRequest,
  AwaitSessionActivityRevisionResult,
  AcpusTasksResult,
  CancelSessionTaskRequest,
  CancelSessionTaskResult,
  HoverResult,
  ReadAgentPresetsRequest,
  ReadAgentPresetsResult,
  ReadActivityDetailRequest,
  ReadActivityDetailResult,
  ReadSessionActivityRequest,
  SessionActivityProjection,
} from "../remote/types.js";
import type { DelegatedTaskSelector, ResolvedTaskSelector } from "../task.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    acpusMode: AcpusMode;
  }
}

export type AcpusModeConfig = {
  dshHome?: string;
  stateDir?: string;
};

export type AcpusRunRequest = {
  workspace: string;
  sessionId: string;
  toolCallId: string;
  workflow: string;
  input?: JsonValue;
  agents?: JsonValue;
  signal?: AbortSignal;
};

export type ApplyAgentPresetsRequest = {
  workspace: string;
  scope: WritableAgentPresetScope;
  changes: readonly AgentPresetChange[];
};

export type ApplyAgentPresetsResult =
  | { status: "applied" }
  | { status: "rejected"; reason: string };

export class AcpusMode extends TypertRemoteService {
  private runtimes!: RuntimePool;
  private links!: RunLinkStore;
  private supervision!: AcpusSupervision;
  private projections!: AcpusProjectionReader;
  private hostScope!: Scope.Closeable;
  private readonly presetOptions: AcpusPresetInstallOptions;
  private readonly stateDir: string;
  private readonly dshHome: string;
  private readonly noticeAdapter: ParentSessionAgentAdapter | undefined;

  constructor(ctx: Context, config: AcpusModeConfig = {}) {
    super(ctx, "acpusMode", { namespace: "acpus" });
    const dshHome = resolve(config.dshHome
      ?? process.env.DSH_HOME
      ?? join(homedir(), ".dsh"));
    this.dshHome = dshHome;
    this.stateDir = resolve(config.stateDir ?? join(dshHome, ".acpus-dsh"));
    this.presetOptions = { dshHome };
    const agents = ctx.get("agents");
    const agentPresets = ctx.get("agentPresets");
    const sessions = ctx.get("sessions");
    const sessionPersistence = ctx.get("sessionPersistence");
    this.noticeAdapter = agents === undefined
      || agentPresets === undefined
      || sessions === undefined
      ? undefined
      : new ParentSessionAgentAdapter({
          agents,
          agentPresets,
          sessions,
          ...(sessionPersistence === undefined ? {} : { sessionPersistence }),
        }, resolveSessionPreset);
  }

  protected async [Service.init](): Promise<void> {
    await installAcpusPreset(this.presetOptions);
    this.hostScope = await Effect.runPromise(this.initializeHost());
    const scope = this.hostScope;
    this.ctx.effect(() => async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }, "acpusMode.supervision");
  }

  private initializeHost(): Effect.Effect<Scope.Closeable> {
    const mode = this;
    return Effect.gen(function* () {
      const scope = yield* Scope.make("parallel");
      const initialized = yield* Effect.exit(Scope.provide(scope)(Effect.gen(function* () {
        const links = new RunLinkStore(join(mode.stateDir, "run-links.json"));
        const runtimes = yield* makeRuntimePool(join(mode.stateDir, "runtime"), {
          namedAgentLaunches: createDshAgentLaunches(mode.dshHome),
          agentPresetProvider: dshAgentPresetProvider,
        });
        const supervision = yield* makeAcpusSupervision({
          runtimes,
          store: links,
          admit: (admissionRequestId, run) => links.admitted(admissionRequestId, run),
          ...(mode.noticeAdapter === undefined ? {} : { notices: mode.noticeAdapter }),
        });
        const projections = new AcpusProjectionReader({
          sessions: {
            readSession: sessionId => links.readSession(sessionId),
            waitForActivityRevision: (sessionId, revision) =>
              supervision.waitForActivityRevision(sessionId, revision),
          },
        });
        yield* Effect.sync(() => {
          mode.links = links;
          mode.runtimes = runtimes;
          mode.supervision = supervision;
          mode.projections = projections;
        });
        yield* mode.reconcilePendingCancels().pipe(
          Effect.catchCause(cause => Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.sync(() => console.error(
                "[acpus/dsh] cancel reconciliation:",
                Cause.squash(cause),
              ))),
          Effect.forkScoped,
        );
      })));
      if (Exit.isSuccess(initialized)) return scope;
      yield* Scope.close(scope, initialized);
      return yield* Effect.failCause(initialized.cause);
    });
  }

  run(request: AcpusRunRequest): Promise<AcpusRunReceipt | InvalidWorkflow> {
    const mode = this;
    const operation = Effect.gen(function* () {
      yield* mode.supervision.whenReady();
      const opened = yield* Effect.result(mode.runtimes.open(request.workspace));
      if (Result.isFailure(opened)) {
        return yield* Effect.fail(runtimePoolOperationError(opened.failure));
      }
      const { workspace, runtime } = opened.success;
      const admissionRequestId = admissionId(request.sessionId, request.toolCallId);
      const identity = {
        workspace,
        admissionRequestId,
        parentSessionId: request.sessionId,
      };
      const existingLink = yield* mode.links.readLink(identity);
      if (existingLink !== undefined) {
        const existingReceipt = yield* readAdmissionReceipt({
          runtime,
          admissionRequestId,
          link: existingLink,
        });
        if (existingReceipt !== undefined) {
          yield* mode.supervision.reconcileRun(existingLink);
          return existingReceipt;
        }
      }
      const prepared = yield* prepareAuthoringWorkflow(workspace, request.workflow);
      if (prepared.status === "invalid") return prepared;
      const normalized = normalizeAuthoringInput(
        prepared.prepared,
        request.input === undefined ? {} : request.input,
      );
      if (normalized.status === "invalid") return normalized;
      const agents = normalizeAgentInjections(
        request.agents ?? {},
        prepared.prepared.ir.agents,
      );
      if (agents.status === "invalid") return agents;
      const presetCatalog = hasPresetInjections(agents.agents)
        ? yield* mode.agentPresetCatalogEffect(workspace)
        : undefined;
      const bindings = preflightAgentBindings(
        prepared.prepared.ir.agents,
        agents.agents,
        presetCatalog,
      );
      if (bindings.status === "invalid") return bindings;
      let link = yield* mode.links.provisional(identity);
      if (link.runId === undefined) {
        const recovered = yield* Effect.result(runtime.findAdmission(admissionRequestId));
        if (Result.isFailure(recovered)) {
          return yield* Effect.fail(new AcpusOperationError(
            recovered.failure.message,
            "ACPUS_READ_FAILED",
          ));
        }
        if (recovered.success !== undefined) {
          link = yield* mode.links.admitted(admissionRequestId, recovered.success);
        }
      }
      const receipt = yield* submitPreparedWorkflow({
        runtime,
        prepared: prepared.prepared,
        normalizedInput: normalized.input,
        agentInjections: agents.agents,
        admissionRequestId,
        link,
        links: mode.links,
      });
      const admitted = (yield* mode.links.listLinks()).find(candidate =>
        candidate.admissionRequestId === admissionRequestId);
      if (admitted !== undefined) yield* mode.supervision.reconcileRun(admitted);
      return receipt;
    });
    return runHostEffect(operation, request.signal);
  }

  runtime(workspace: string): Promise<WorkspaceRuntime> {
    const mode = this;
    return runHostEffect(Effect.gen(function* () {
      yield* mode.supervision.whenReady();
      const opened = yield* Effect.result(mode.runtimes.open(workspace));
      return yield* Result.match(opened, {
        onSuccess: value => Effect.succeed(value.runtime),
        onFailure: failure => Effect.fail(runtimePoolOperationError(failure)),
      });
    }));
  }

  async trustedAgentPresetChoices(): Promise<readonly AgentPresetChoice[]> {
    return (await this.agentPresetCatalog(undefined, ["host", "global"])).choices;
  }

  agentPresetChoices(workspace: string): Promise<AgentPresetSelectionView[]> {
    return this.loadAgentPresetSelections(workspace);
  }

  async applyAgentPresets(
    input: ApplyAgentPresetsRequest,
  ): Promise<ApplyAgentPresetsResult> {
    const applied = await Effect.runPromise(Effect.result(applyAgentPresetChanges({
      workspaceDir: input.workspace,
      scope: input.scope,
      changes: input.changes,
    })));
    return Result.match(applied, {
      onSuccess: () => ({ status: "applied" as const }),
      onFailure: failure => ({ status: "rejected" as const, reason: failure.type }),
    });
  }

  private async loadAgentPresetSelections(
    workspace: string | undefined,
    scopes?: readonly AgentPresetScope[],
  ): Promise<AgentPresetSelectionView[]> {
    return (await this.agentPresetCatalog(workspace, scopes)).choices
      .map(toAgentPresetSelectionView);
  }

  private async agentPresetCatalog(
    workspace: string | undefined,
    scopes?: readonly AgentPresetScope[],
  ): Promise<AgentPresetCatalog> {
    return runHostEffect(this.agentPresetCatalogEffect(workspace, scopes));
  }

  private agentPresetCatalogEffect(
    workspace: string | undefined,
    scopes?: readonly AgentPresetScope[],
  ): Effect.Effect<AgentPresetCatalog, AcpusOperationError> {
    return Effect.result(loadAgentPresetCatalog({
      ...(workspace === undefined ? {} : { workspaceDir: workspace }),
      hostProvider: dshAgentPresetProvider,
      ...(scopes === undefined ? {} : { scopes }),
    })).pipe(Effect.flatMap(loaded => Result.isSuccess(loaded)
      ? Effect.succeed(loaded.success)
      : Effect.fail(new AcpusOperationError(
          "Acpus could not read the Agent Preset catalog.",
          "ACPUS_AGENT_PRESET_CATALOG_FAILED",
          { cause: loaded.failure },
        ))));
  }

  tasks(sessionId: string, name?: string): Promise<AcpusTasksResult> {
    return runHostEffect(this.projections.readTasks(sessionId, name));
  }

  resolveTask(
    sessionId: string,
    selector?: DelegatedTaskSelector,
  ): Promise<{
    runId: string;
    workspace: string;
    runtime: WorkspaceRuntime;
    generation: number;
    selector: ResolvedTaskSelector;
    link: AdmittedRunLink;
  }> {
    const mode = this;
    return runHostEffect(Effect.gen(function* () {
      let resolved = selector;
      if (resolved !== undefined && (resolved.name.length === 0
        || !Number.isSafeInteger(resolved.occurrence) || resolved.occurrence < 1)) {
        return yield* Effect.fail(new AcpusOperationError(
          "A delegated task selector requires an exact non-empty workflow name and a positive occurrence.",
          "ACPUS_TASK_NOT_FOUND",
        ));
      }
      const session = yield* mode.links.readSession(sessionId);
      if (resolved === undefined) {
        const latest = session.runs.reduce<typeof session.runs[number] | undefined>(
          (selected, run) => selected === undefined || run.generation > selected.generation
            ? run
            : selected,
          undefined,
        );
        if (latest === undefined) {
          return yield* Effect.fail(new AcpusOperationError(
            "This DSH session has no delegated task.",
            "ACPUS_TASK_NOT_FOUND",
          ));
        }
        resolved = { name: latest.name, occurrence: latest.occurrence };
      }
      const selected = session.runs.find(run =>
        run.name === resolved.name && run.occurrence === resolved.occurrence);
      if (selected === undefined) {
        return yield* Effect.fail(new AcpusOperationError(
          `Workflow '${resolved.name}' occurrence ${resolved.occurrence} was not found in this DSH session.`,
          "ACPUS_TASK_NOT_FOUND",
        ));
      }
      const link = (yield* mode.links.listLinks()).find(candidate =>
        candidate.parentSessionId === sessionId
        && candidate.generation === selected.generation);
      if (!isAdmittedLink(link)) {
        return yield* Effect.fail(new AcpusOperationError(
          `Workflow '${resolved.name}' is not available for control.`,
          "ACPUS_TASK_NOT_FOUND",
        ));
      }
      const opened = yield* Effect.result(mode.supervision.openLinkedRuntime(link));
      if (Result.isFailure(opened)) {
        return yield* Effect.fail(linkedRuntimeError(opened.failure));
      }
      return {
        runId: link.runId,
        workspace: link.workspace,
        runtime: opened.success.runtime,
        generation: link.generation,
        selector: { name: link.workflowName, occurrence: link.occurrence },
        link,
      };
    }));
  }

  reconcileTask(link: AdmittedRunLink): Promise<void> {
    return runHostEffect(this.supervision.reconcileRun(link));
  }

  linkFork(
    sessionId: string,
    toolCallId: string,
    sourceGeneration: number,
    workspace: string,
    run: { id: string; name: string },
  ): Promise<ResolvedTaskSelector> {
    const mode = this;
    return runHostEffect(Effect.gen(function* () {
      const admissionRequestId = `dsh-control:${toolCallId}`;
      yield* mode.links.provisional({
        workspace,
        admissionRequestId,
        parentSessionId: sessionId,
        forkedFromGeneration: sourceGeneration,
      });
      const link = yield* mode.links.admitted(admissionRequestId, run);
      yield* mode.supervision.reconcileRun(link);
      return { name: link.workflowName, occurrence: link.occurrence };
    }));
  }

  @Remote
  async readAgentPresets(
    _input: ReadAgentPresetsRequest,
  ): Promise<ReadAgentPresetsResult> {
    const catalog = await this.agentPresetCatalog(undefined, ["host", "global"]);
    return { presets: toAgentPresetViews(catalog) };
  }

  @Remote
  readSessionActivity(
    input: ReadSessionActivityRequest,
  ): Promise<SessionActivityProjection> {
    return runHostEffect(this.projections.readSessionActivity(input.sessionId, input.task));
  }

  @Remote
  async readActivityDetail(
    input: ReadActivityDetailRequest,
  ): Promise<ReadActivityDetailResult> {
    const session = await runHostEffect(this.links.readSession(input.sessionId));
    const task = session.runs.find(candidate => candidate.generation === input.generation);
    if (task === undefined) return { status: "rejected", reason: "task-unavailable" };
    const node = findStoredActivityNode(task.activity, input.activityId);
    const agent = node?.agent?.name;
    if (node === undefined
      || (node.kind !== "agent" && node.kind !== "task")
      || node.target === undefined) {
      return { status: "rejected", reason: "node-unavailable" };
    }
    try {
      const link = (await runHostEffect(this.links.listLinks())).find(candidate =>
        candidate.parentSessionId === input.sessionId
        && candidate.generation === input.generation);
      if (!isAdmittedLink(link)) return { status: "rejected", reason: "task-unavailable" };
      const opened = await runHostEffect(Effect.result(this.supervision.openLinkedRuntime(link)));
      if (Result.isFailure(opened)) return { status: "rejected", reason: "temporarily-unavailable" };
      const runtime = opened.success.runtime;
      const view = await Effect.runPromise(runtime.inspect({
        kind: "target",
        runId: task.runId,
        target: node.target,
        detail: "forensics",
      }));
      if (view.kind !== "target" || view.detail !== "forensics" || view.definition.kind !== node.kind) {
        return { status: "rejected", reason: "node-unavailable" };
      }
      let detail: Extract<ReadActivityDetailResult, { status: "available" }>["detail"] | undefined;
      if (node.kind === "agent") {
        if (agent === undefined) return { status: "rejected", reason: "node-unavailable" };
        detail = agentHoverDetail(agent, view);
      } else {
        detail = taskHoverDetail(view);
      }
      if (detail === undefined) return { status: "rejected", reason: "detail-unavailable" };
      return {
        status: "available",
        detail,
      };
    } catch {
      return { status: "rejected", reason: "temporarily-unavailable" };
    }
  }

  @Remote
  awaitSessionActivityRevision(
    input: AwaitSessionActivityRevisionRequest,
    signal: AbortSignal,
  ): Promise<AwaitSessionActivityRevisionResult> {
    return runHostEffect(
      this.projections.awaitSessionActivityRevision(input.sessionId, input.afterRevision),
      signal,
    );
  }

  @Remote
  cancelSessionTask(
    input: CancelSessionTaskRequest,
  ): Promise<CancelSessionTaskResult> {
    const mode = this;
    return runHostEffect(Effect.gen(function* () {
      const selected = (yield* mode.links.listLinks()).find(link =>
        link.parentSessionId === input.sessionId && link.generation === input.generation);
      const selector = isAdmittedLink(selected)
        ? { name: selected.workflowName, occurrence: selected.occurrence }
        : undefined;
      const prepared = yield* mode.links.prepareCancel({
        sessionId: input.sessionId,
        generation: input.generation,
        actor: "user",
      });
      if (prepared.status === "rejected") {
        if (prepared.reason === "already-terminal") {
          yield* mode.supervision.scheduleNoticeDelivery(input.sessionId);
        }
        return {
          status: "rejected" as const,
          reason: prepared.reason,
          projection: yield* mode.projections.readSessionActivity(input.sessionId, selector),
        };
      }
      return yield* mode.applyUserCancel(prepared.control, prepared.link);
    }));
  }

  prepareModelCancel(
    sessionId: string,
    generation: number,
    requestId: string,
  ): Promise<
    | { status: "ready"; control: StoredControl; link: AdmittedRunLink }
    | { status: "rejected"; reason: "task-unavailable" | "already-terminal" }
  > {
    return runHostEffect(this.links.prepareCancel({
      sessionId,
      generation,
      actor: "model",
      requestId,
    }));
  }

  settleModelCancel(
    controlId: string,
    outcome: "applied" | "rejected",
    reason?: "not-controllable" | "temporarily-unavailable",
  ): Promise<void> {
    return runHostEffect(this.links.settleCancel({
      controlId,
      outcome,
      taskStatus: outcome === "applied" ? "canceled" : "running",
      ...(reason === undefined ? {} : { reason }),
    }));
  }

  private applyUserCancel(
    control: StoredControl,
    link: AdmittedRunLink,
  ): Effect.Effect<CancelSessionTaskResult, Error> {
    const mode = this;
    const selector = { name: link.workflowName, occurrence: link.occurrence };
    return Effect.gen(function* () {
      const opened = yield* Effect.result(mode.supervision.openLinkedRuntime(link));
      if (Result.isFailure(opened)) {
        return {
          status: "rejected" as const,
          reason: "temporarily-unavailable" as const,
          projection: yield* mode.projections.readSessionActivity(
            control.parentSessionId,
            selector,
          ),
        };
      }
      const result = yield* Effect.result(opened.success.runtime.control({
        type: "cancel",
        runId: link.runId,
        requestId: control.requestId,
      }));
      if (Result.isFailure(result)) {
        const reason = result.failure.code === "RUN_NOT_CONTROLLABLE"
          ? "not-controllable" as const
          : "temporarily-unavailable" as const;
        yield* mode.links.settleCancel({
          controlId: control.id,
          outcome: "rejected",
          taskStatus: "running",
          reason,
        });
        yield* mode.supervision.scheduleNoticeDelivery(control.parentSessionId);
        return {
          status: "rejected" as const,
          reason,
          projection: yield* mode.projections.readSessionActivity(
            control.parentSessionId,
            selector,
          ),
        };
      }
      yield* mode.links.settleCancel({
        controlId: control.id,
        outcome: "applied",
        taskStatus: "canceled",
      });
      yield* mode.supervision.reconcileRun(link);
      yield* mode.supervision.scheduleNoticeDelivery(control.parentSessionId);
      return {
        status: "applied" as const,
        projection: yield* mode.projections.readSessionActivity(
          control.parentSessionId,
          selector,
        ),
      };
    });
  }

  private reconcilePendingCancels(): Effect.Effect<void, Error> {
    const mode = this;
    return Effect.gen(function* () {
      yield* mode.supervision.whenReady();
      const controls = yield* mode.links.pendingControls();
      yield* Effect.forEach(
        controls,
        control => mode.reconcilePendingCancel(control).pipe(
          Effect.catchCause(cause => Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.sync(() => console.error(
                `[acpus/dsh] cancel reconciliation for ${control.runId}:`,
                Cause.squash(cause),
              ))),
        ),
        { concurrency: 1, discard: true },
      );
      yield* mode.supervision.scheduleNoticeDelivery();
    });
  }

  private reconcilePendingCancel(control: StoredControl): Effect.Effect<void, Error> {
    const mode = this;
    return Effect.gen(function* () {
      const link = (yield* mode.links.listLinks()).find(candidate =>
        candidate.parentSessionId === control.parentSessionId
        && candidate.generation === control.generation
        && candidate.runId === control.runId);
      if (!isAdmittedLink(link)) return;
      const projection = (yield* mode.links.readSession(control.parentSessionId)).runs
        .find(run => run.runId === control.runId);
      if (projection !== undefined
        && ["completed", "failed", "canceled"].includes(projection.status)) {
        yield* mode.links.settleCancel({
          controlId: control.id,
          outcome: "rejected",
          taskStatus: projection.status,
          reason: "already-terminal",
        });
        return;
      }
      if (control.actor === "user") {
        yield* mode.applyUserCancel(control, link);
        return;
      }
      const opened = yield* Effect.result(mode.supervision.openLinkedRuntime(link));
      if (Result.isFailure(opened)) return;
      const result = yield* Effect.result(opened.success.runtime.control({
        type: "cancel",
        runId: link.runId,
        requestId: control.requestId,
      }));
      yield* mode.links.settleCancel({
        controlId: control.id,
        outcome: Result.isSuccess(result) ? "applied" : "rejected",
        taskStatus: Result.isSuccess(result) ? "canceled" : "running",
        ...(Result.isFailure(result)
          ? {
              reason: result.failure.code === "RUN_NOT_CONTROLLABLE"
                ? "not-controllable" as const
                : "temporarily-unavailable" as const,
            }
          : {}),
      });
      yield* mode.supervision.reconcileRun(link);
    });
  }
}

function admissionId(sessionId: string, toolCallId: string): string {
  return `dsh:${createHash("sha256").update(sessionId).update("\0").update(toolCallId).digest("hex")}`;
}

function isAdmittedLink(link: RunLink | undefined): link is AdmittedRunLink {
  return link?.runId !== undefined
    && link.workflowName !== undefined
    && link.occurrence !== undefined;
}

function linkedRuntimeError(failure: RuntimePoolOpenFailure | Error): Error {
  return failure instanceof Error ? failure : runtimePoolOperationError(failure);
}

async function runHostEffect<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  if (signal === undefined) return Effect.runPromise(effect);
  try {
    return await Effect.runPromise(effect, { signal });
  } catch (error) {
    if (signal.aborted) throw abortError(signal.reason);
    throw error;
  }
}

const PROMPT_LIMIT = 16 * 1024;
const INPUT_LIMIT = 16 * 1024;
const OUTPUT_LIMIT = 64 * 1024;

function agentHoverDetail(
  agent: string,
  view: InspectionForensicsView,
): Extract<ReadActivityDetailResult, { status: "available" }>["detail"] {
  if (view.definition.kind !== "agent") throw new Error("Agent forensics definition is required.");
  const invocation = view.invocation.status === "resolved" && view.invocation.kind === "agent"
    ? view.invocation
    : undefined;
  const model = invocation?.model
    ?? view.definition.effective.model;
  const result = hoverResult(view.result);
  return {
    kind: "agent",
    agent,
    ...(model === undefined || model.length === 0 ? {} : { model }),
    ...(invocation === undefined
      ? {}
      : {
          prompt: {
            ...boundedText(invocation.prompt, PROMPT_LIMIT),
            origin: invocation.promptOrigin,
          },
        }),
    ...(result === undefined ? {} : { result }),
  };
}

function taskHoverDetail(
  view: InspectionForensicsView,
): Extract<ReadActivityDetailResult, { status: "available" }>["detail"] | undefined {
  if (view.definition.kind !== "task") throw new Error("Task forensics definition is required.");
  if (view.invocation.status !== "resolved" || view.invocation.kind !== "task") return undefined;
  const result = hoverResult(view.result);
  return {
    kind: "task",
    input: boundedValue(view.invocation.input, INPUT_LIMIT),
    ...(result === undefined ? {} : { result }),
  };
}

function hoverResult(
  result: InspectionForensicsView["result"],
): HoverResult | undefined {
  if (result.status === "accepted") {
    return { kind: "output", ...boundedValue(result.value, OUTPUT_LIMIT) };
  }
  if (result.status === "completed_without_output") return { kind: "completed-without-output" };
  if (result.status === "failed" || result.status === "timed_out") {
    return {
      kind: result.status === "failed" ? "failed" : "timed-out",
      ...(result.code === undefined ? {} : { code: result.code }),
      message: result.message,
    };
  }
  if (result.status === "cancelled") return { kind: "canceled" };
  return undefined;
}

function boundedValue(
  value: JsonValue,
  limit: number,
): { format: "text" | "json"; text: string; truncated: boolean } {
  return typeof value === "string"
    ? { format: "text", ...boundedText(value, limit) }
    : { format: "json", ...boundedText(JSON.stringify(value, null, 2), limit) };
}

function boundedText(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  return {
    text: Buffer.from(text).subarray(0, limit).toString("utf8").replace(/\uFFFD$/u, ""),
    truncated: true,
  };
}
