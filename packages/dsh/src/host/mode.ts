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
  type AgentPresetScope,
  type InspectionForensicsView,
  type WritableAgentPresetScope,
} from "@acpus/runtime";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import { AcpusOperationError, runtimePoolOperationError } from "./errors.js";
import {
  dshAgentPresetProvider,
  toAgentPresetView,
} from "./agent-presets.js";
import { RuntimePool } from "./runtime-pool.js";
import { createDshAgentLaunches } from "./dsh-agent.js";
import { RunLinkStore } from "./run-links.js";
import type { AdmittedRunLink } from "./run-links.js";
import { ParentSessionAgentAdapter } from "./session-agent.js";
import { AcpusSupervision } from "./supervision.js";
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
import { AcpusProjectionReader } from "../remote/reader.js";
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
  AgentPresetView,
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
  private readonly runtimes: RuntimePool;
  private readonly links: RunLinkStore;
  private readonly supervision: AcpusSupervision;
  private readonly projections: AcpusProjectionReader;
  private readonly presetOptions: AcpusPresetInstallOptions;

  constructor(ctx: Context, config: AcpusModeConfig = {}) {
    super(ctx, "acpusMode", { namespace: "acpus" });
    const dshHome = resolve(config.dshHome
      ?? process.env.DSH_HOME
      ?? join(homedir(), ".dsh"));
    const stateDir = resolve(config.stateDir ?? join(dshHome, ".acpus-dsh"));
    this.presetOptions = { dshHome };
    this.runtimes = new RuntimePool(
      join(stateDir, "runtime"),
      {
        namedAgentLaunches: createDshAgentLaunches(dshHome),
        agentPresetProvider: dshAgentPresetProvider,
      },
    );
    this.links = new RunLinkStore(
      join(stateDir, "run-links.json"),
    );
    const agents = ctx.get("agents");
    const agentPresets = ctx.get("agentPresets");
    const sessions = ctx.get("sessions");
    const sessionPersistence = ctx.get("sessionPersistence");
    const noticeAdapter = agents === undefined
      || agentPresets === undefined
      || sessions === undefined
      ? undefined
      : new ParentSessionAgentAdapter({
          agents,
          agentPresets,
          sessions,
          ...(sessionPersistence === undefined ? {} : { sessionPersistence }),
        }, resolveSessionPreset);
    this.supervision = new AcpusSupervision({
      runtimes: this.runtimes,
      store: this.links,
      admit: (admissionRequestId, run) =>
        this.links.admitted(admissionRequestId, run),
      ...(noticeAdapter === undefined ? {} : { notices: noticeAdapter }),
    });
    this.projections = new AcpusProjectionReader({
      sessions: {
        readSession: sessionId => this.links.readSession(sessionId),
        waitForActivityRevision: (sessionId, revision, signal) =>
          this.supervision.waitForActivityRevision(sessionId, revision, signal),
      },
    });
  }

  protected async [Service.init](): Promise<void> {
    await installAcpusPreset(this.presetOptions);
    this.supervision.start();
    void this.reconcilePendingCancels().catch(error =>
      console.error("[acpus/dsh] cancel reconciliation:", error));
    this.ctx.effect(() => async () => {
      const settled = await Promise.allSettled([
        this.supervision.dispose(),
        this.runtimes.close(),
      ]);
      const failures = settled.flatMap(result =>
        result.status === "rejected" ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Acpus DSH mode did not close cleanly.");
      }
    }, "acpusMode.supervision");
  }

  async run(request: AcpusRunRequest): Promise<AcpusRunReceipt | InvalidWorkflow> {
    await this.supervision.whenReady();
    const opened = await this.runtimes.open(request.workspace);
    if (opened.isErr()) throw runtimePoolOperationError(opened.error);
    const { workspace, runtime } = opened.value;
    const admissionRequestId = admissionId(request.sessionId, request.toolCallId);
    const identity = {
      workspace,
      admissionRequestId,
      parentSessionId: request.sessionId,
    };
    const existingLink = await this.links.readLink(identity);
    if (existingLink !== undefined) {
      const existingReceipt = await readAdmissionReceipt({
        runtime,
        admissionRequestId,
        link: existingLink,
      });
      if (existingReceipt !== undefined) {
        await this.supervision.reconcileRun(existingLink);
        return existingReceipt;
      }
    }
    const prepared = await prepareAuthoringWorkflow(workspace, request.workflow);
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
      ? await this.agentPresetCatalog(workspace)
      : undefined;
    const bindings = await preflightAgentBindings(
      prepared.prepared.ir.agents,
      agents.agents,
      presetCatalog,
    );
    if (bindings.status === "invalid") return bindings;
    let link = await this.links.provisional(identity);
    if (link.runId === undefined) {
      const recovered = await runtime.findAdmission(admissionRequestId);
      if (recovered.isErr()) throw new AcpusOperationError(recovered.error.message, "ACPUS_READ_FAILED");
      if (recovered.value !== undefined) {
        link = await this.links.admitted(admissionRequestId, recovered.value);
      }
    }
    const receipt = await submitPreparedWorkflow({
      runtime,
      prepared: prepared.prepared,
      normalizedInput: normalized.input,
      agentInjections: agents.agents,
      admissionRequestId,
      link,
      links: this.links,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const admitted = (await this.links.listLinks()).find(candidate =>
      candidate.admissionRequestId === admissionRequestId);
    if (admitted !== undefined) await this.supervision.reconcileRun(admitted);
    return receipt;
  }

  async runtime(workspace: string): Promise<WorkspaceRuntime> {
    await this.supervision.whenReady();
    const opened = await this.runtimes.open(workspace);
    if (opened.isErr()) throw runtimePoolOperationError(opened.error);
    return opened.value.runtime;
  }

  async trustedAgentPresetChoices(): Promise<AgentPresetView[]> {
    return this.loadAgentPresetChoices(undefined, ["host", "global"]);
  }

  agentPresetChoices(workspace: string): Promise<AgentPresetView[]> {
    return this.loadAgentPresetChoices(workspace);
  }

  async applyAgentPresets(
    input: ApplyAgentPresetsRequest,
  ): Promise<ApplyAgentPresetsResult> {
    const applied = await applyAgentPresetChanges({
      workspaceDir: input.workspace,
      scope: input.scope,
      changes: input.changes,
    });
    return applied.match(
      () => ({ status: "applied" }),
      failure => ({ status: "rejected", reason: failure.type }),
    );
  }

  private async loadAgentPresetChoices(
    workspace: string | undefined,
    scopes?: readonly AgentPresetScope[],
  ): Promise<AgentPresetView[]> {
    return (await this.agentPresetCatalog(workspace, scopes)).choices
      .map(toAgentPresetView);
  }

  private async agentPresetCatalog(
    workspace: string | undefined,
    scopes?: readonly AgentPresetScope[],
  ): Promise<AgentPresetCatalog> {
    const loaded = await loadAgentPresetCatalog({
      ...(workspace === undefined ? {} : { workspaceDir: workspace }),
      hostProvider: dshAgentPresetProvider,
      ...(scopes === undefined ? {} : { scopes }),
    });
    if (loaded.isErr()) {
      throw new AcpusOperationError(
        "Acpus could not read the Agent Preset catalog.",
        "ACPUS_AGENT_PRESET_CATALOG_FAILED",
        { cause: loaded.error },
      );
    }
    return loaded.value;
  }

  tasks(sessionId: string, name?: string): Promise<AcpusTasksResult> {
    return this.projections.readTasks(sessionId, name);
  }

  async resolveTask(
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
    if (selector !== undefined && (selector.name.length === 0
      || !Number.isSafeInteger(selector.occurrence) || selector.occurrence < 1)) {
      throw new AcpusOperationError(
        "A delegated task selector requires an exact non-empty workflow name and a positive occurrence.",
        "ACPUS_TASK_NOT_FOUND",
      );
    }
    const session = await this.links.readSession(sessionId);
    if (selector === undefined) {
      const latest = session.runs.reduce<typeof session.runs[number] | undefined>(
        (selected, run) => selected === undefined || run.generation > selected.generation ? run : selected,
        undefined,
      );
      if (latest === undefined) {
        throw new AcpusOperationError(
          "This DSH session has no delegated task.",
          "ACPUS_TASK_NOT_FOUND",
        );
      }
      selector = { name: latest.name, occurrence: latest.occurrence };
    }
    const named = session.runs.filter(run => run.name === selector.name);
    const selected = named.find(run => run.occurrence === selector.occurrence);
    if (selected === undefined) {
      throw new AcpusOperationError(
        `Workflow '${selector.name}' occurrence ${selector.occurrence} was not found in this DSH session.`,
        "ACPUS_TASK_NOT_FOUND",
      );
    }
    const link = (await this.links.listLinks()).find(candidate =>
      candidate.parentSessionId === sessionId
      && candidate.generation === selected.generation);
    if (!isAdmittedLink(link)) {
      throw new AcpusOperationError(
        `Workflow '${selector.name}' is not available for control.`,
        "ACPUS_TASK_NOT_FOUND",
      );
    }
    const opened = await this.supervision.openLinkedRuntime(link);
    if (opened.isErr()) throw runtimePoolOperationError(opened.error);
    return {
      runId: link.runId,
      workspace: link.workspace,
      runtime: opened.value.runtime,
      generation: link.generation,
      selector: { name: link.workflowName, occurrence: link.occurrence },
      link,
    };
  }

  async reconcileTask(link: AdmittedRunLink): Promise<void> {
    await this.supervision.reconcileRun(link);
  }

  async linkFork(
    sessionId: string,
    toolCallId: string,
    sourceGeneration: number,
    workspace: string,
    run: { id: string; name: string },
  ): Promise<ResolvedTaskSelector> {
    const admissionRequestId = `dsh-control:${toolCallId}`;
    await this.links.provisional({
      workspace,
      admissionRequestId,
      parentSessionId: sessionId,
      forkedFromGeneration: sourceGeneration,
    });
    const link = await this.links.admitted(admissionRequestId, run);
    await this.supervision.reconcileRun(link);
    return { name: link.workflowName, occurrence: link.occurrence };
  }

  @Remote
  async readAgentPresets(
    _input: ReadAgentPresetsRequest,
  ): Promise<ReadAgentPresetsResult> {
    return { presets: await this.trustedAgentPresetChoices() };
  }

  @Remote
  readSessionActivity(
    input: ReadSessionActivityRequest,
  ): Promise<SessionActivityProjection> {
    return this.projections.readSessionActivity(input.sessionId, input.task);
  }

  @Remote
  async readActivityDetail(
    input: ReadActivityDetailRequest,
  ): Promise<ReadActivityDetailResult> {
    const session = await this.links.readSession(input.sessionId);
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
      const link = (await this.links.listLinks()).find(candidate =>
        candidate.parentSessionId === input.sessionId
        && candidate.generation === input.generation);
      if (!isAdmittedLink(link)) return { status: "rejected", reason: "task-unavailable" };
      const opened = await this.supervision.openLinkedRuntime(link);
      if (opened.isErr()) return { status: "rejected", reason: "temporarily-unavailable" };
      const runtime = opened.value.runtime;
      const inspected = await runtime.inspect({
        kind: "target",
        runId: task.runId,
        target: node.target,
        detail: "forensics",
      });
      if (inspected.isErr()) {
        return { status: "rejected", reason: "temporarily-unavailable" };
      }
      const view = inspected.value;
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
    return this.projections.awaitSessionActivityRevision(
      input.sessionId,
      input.afterRevision,
      signal,
    );
  }

  @Remote
  async cancelSessionTask(
    input: CancelSessionTaskRequest,
  ): Promise<CancelSessionTaskResult> {
    const selected = (await this.links.listLinks()).find(link =>
      link.parentSessionId === input.sessionId && link.generation === input.generation);
    const selector = isAdmittedLink(selected)
      ? { name: selected.workflowName, occurrence: selected.occurrence }
      : undefined;
    const prepared = await this.links.prepareCancel({
      sessionId: input.sessionId,
      generation: input.generation,
      actor: "user",
    });
    if (prepared.status === "rejected") {
      if (prepared.reason === "already-terminal") {
        this.supervision.scheduleNoticeDelivery(input.sessionId);
      }
      return {
        status: "rejected",
        reason: prepared.reason,
        projection: await this.projections.readSessionActivity(input.sessionId, selector),
      };
    }
    return this.applyUserCancel(prepared.control, prepared.link);
  }

  async prepareModelCancel(
    sessionId: string,
    generation: number,
    requestId: string,
  ): Promise<Awaited<ReturnType<RunLinkStore["prepareCancel"]>>> {
    return this.links.prepareCancel({ sessionId, generation, actor: "model", requestId });
  }

  async settleModelCancel(
    controlId: string,
    outcome: "applied" | "rejected",
    reason?: "not-controllable" | "temporarily-unavailable",
  ): Promise<void> {
    await this.links.settleCancel({
      controlId,
      outcome,
      taskStatus: outcome === "applied" ? "canceled" : "running",
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private async applyUserCancel(
    control: Awaited<ReturnType<RunLinkStore["pendingControls"]>>[number],
    link: AdmittedRunLink,
  ): Promise<CancelSessionTaskResult> {
    const opened = await this.supervision.openLinkedRuntime(link);
    if (opened.isErr()) {
      return {
        status: "rejected",
        reason: "temporarily-unavailable",
        projection: await this.projections.readSessionActivity(control.parentSessionId, {
          name: link.workflowName,
          occurrence: link.occurrence,
        }),
      };
    }
    const runtime = opened.value.runtime;
    const result = await runtime.control({
      type: "cancel",
      runId: link.runId,
      requestId: control.requestId,
    });
    if (result.isErr()) {
      const reason = result.error.code === "RUN_NOT_CONTROLLABLE"
        ? "not-controllable" as const
        : "temporarily-unavailable" as const;
      await this.links.settleCancel({
        controlId: control.id,
        outcome: "rejected",
        taskStatus: "running",
        reason,
      });
      this.supervision.scheduleNoticeDelivery(control.parentSessionId);
      return {
      status: "rejected",
      reason,
      projection: await this.projections.readSessionActivity(control.parentSessionId, {
        name: link.workflowName,
        occurrence: link.occurrence,
      }),
      };
    }
    await this.links.settleCancel({
      controlId: control.id,
      outcome: "applied",
      taskStatus: "canceled",
    });
    await this.supervision.reconcileRun(link);
    this.supervision.scheduleNoticeDelivery(control.parentSessionId);
    return {
      status: "applied",
      projection: await this.projections.readSessionActivity(control.parentSessionId, {
        name: link.workflowName,
        occurrence: link.occurrence,
      }),
    };
  }

  private async reconcilePendingCancels(): Promise<void> {
    await this.supervision.whenReady();
    for (const control of await this.links.pendingControls()) {
      try {
        const link = (await this.links.listLinks()).find(candidate =>
          candidate.parentSessionId === control.parentSessionId
          && candidate.generation === control.generation
          && candidate.runId === control.runId);
        if (!isAdmittedLink(link)) continue;
        const projection = (await this.links.readSession(control.parentSessionId)).runs
          .find(run => run.runId === control.runId);
        if (projection !== undefined
          && ["completed", "failed", "canceled"].includes(projection.status)) {
          await this.links.settleCancel({
            controlId: control.id,
            outcome: "rejected",
            taskStatus: projection.status,
            reason: "already-terminal",
          });
          continue;
        }
        if (control.actor === "user") {
          await this.applyUserCancel(control, link);
          continue;
        }
        const opened = await this.supervision.openLinkedRuntime(link);
        if (opened.isErr()) continue;
        const result = await opened.value.runtime.control({
          type: "cancel",
          runId: link.runId,
          requestId: control.requestId,
        });
        await this.links.settleCancel({
          controlId: control.id,
          outcome: result.isOk() ? "applied" : "rejected",
          taskStatus: result.isOk() ? "canceled" : "running",
          ...(result.isErr()
            ? {
                reason: result.error.code === "RUN_NOT_CONTROLLABLE"
                  ? "not-controllable" as const
                  : "temporarily-unavailable" as const,
              }
            : {}),
        });
        await this.supervision.reconcileRun(link);
      } catch (error) {
        console.error(`[acpus/dsh] cancel reconciliation for ${control.runId}:`, error);
      }
    }
    this.supervision.scheduleNoticeDelivery();
  }
}

function admissionId(sessionId: string, toolCallId: string): string {
  return `dsh:${createHash("sha256").update(sessionId).update("\0").update(toolCallId).digest("hex")}`;
}

function isAdmittedLink(link: Awaited<ReturnType<RunLinkStore["listLinks"]>>[number] | undefined): link is AdmittedRunLink {
  return link?.runId !== undefined
    && link.workflowName !== undefined
    && link.occurrence !== undefined;
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
    ?? view.definition.binding.effective.model
    ?? view.definition.profile.model;
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
