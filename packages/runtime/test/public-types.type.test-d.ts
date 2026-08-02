import { expectTypeOf, test } from "vitest";
import {
  DAEMON_PROTOCOL_VERSION,
  createWorkflowVisualizationOverlay,
  daemonEndpoint,
  deleteRun,
  getRun,
  getRuntimeHealth,
  getRunVisualizationSnapshot,
  inspectAgentExecution,
  inspectNode,
  inspectTargetArtifacts,
  listArtifacts,
  listRuns,
  observeInspection,
  resolveArtifact,
  readInspection,
  requestDaemonAdmitRun,
  requestDaemonControl,
  requestDaemonShutdown,
  requestDaemonStatus,
  startDaemonLoop,
  tryLoadRuntimeConfiguration,
  tryNormalizeForkInput,
  tryNormalizeWorkflowInput,
  tryValidateAgentOverrides,
} from "@acpus/runtime";
import type {
  AdmitRunFailure,
  AgentHostPolicy,
  AgentHostPolicyFailure,
  AgentOutputProcessing,
  AgentOverrideMap,
  AgentOverrideValidationFailure,
  AgentTurnArtifact,
  ArtifactResolutionFailure,
  ArtifactRecord,
  DaemonAdmitRunInput,
  DaemonClientFailure,
  DaemonControlIntent,
  DaemonControlResult,
  DaemonLoopHandle,
  DaemonLoopOptions,
  DaemonShutdownResult,
  DaemonStatus,
  ForkInputNormalizationFailure,
  InspectAgentExecutionQuery,
  InspectionCandidates,
  InspectionError,
  InspectionObservation,
  InspectionRead,
  InspectionView,
  InspectionViewQuery,
  InspectNodeQuery,
  InspectTargetArtifactsQuery,
  ObserveInspectionQuery,
  PreparedRunValidationFailure,
  PreparedRunWorkflow,
  ReadInspectionQuery,
  RunDeleteFailure,
  RunDetails,
  RunDynamicAttempt,
  RunDynamicDetails,
  RunDynamicFrame,
  RunDynamicGroupMember,
  RunDynamicNodeInstance,
  RunDynamicSignalWait,
  RunForkInfo,
  RunInspectionAgentExecutionDocument,
  RunInspectionDetailedFailure,
  RunInspectionError,
  RunInspectionNodeDocument,
  RunInspectionStatus,
  RunInspectionTargetArtifactsDocument,
  RunIncident,
  RunNodeProgress,
  RunRecord,
  RunStatus,
  RunVisualizationSnapshot,
  RunWorkflowLockArtifact,
  RuntimeConfiguration,
  RuntimeConfigurationFailure,
  RuntimeHealthCheck,
  RuntimeHealthReport,
  RuntimePersistence,
  ResolvedArtifact,
  SchemaNormalizationFailure,
  Sha256Digest,
  WorkflowSourceBundle,
  WorkflowSourceFile,
  WorkflowSourceRef,
  WorkflowVisualizationGroup,
  WorkflowVisualizationNode,
  WorkflowVisualizationOverlay,
} from "@acpus/runtime";
import type { WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { AgentTurnSummary } from "@acpus/agent-executor";
import type {
  PreparedWorkflow as CompilerPreparedWorkflow,
  Sha256Digest as CompilerSha256Digest,
  WorkflowPreparationLock as CompilerWorkflowPreparationLock,
  WorkflowSourceBundle as CompilerWorkflowSourceBundle,
  WorkflowSourceFile as CompilerWorkflowSourceFile,
  WorkflowSourceRef as CompilerWorkflowSourceRef,
} from "@acpus/workflow-compiler";
import type { Result, ResultAsync } from "neverthrow";

test("@acpus/runtime exposes one coherent inspection surface and narrow web reads", () => {
  expectTypeOf(readInspection).toEqualTypeOf<
    (cwd: string, query: ReadInspectionQuery) => ResultAsync<InspectionRead, InspectionError>
  >();
  expectTypeOf(observeInspection).toEqualTypeOf<
    (cwd: string, query: ObserveInspectionQuery) => AsyncIterable<Result<InspectionObservation, InspectionError>>
  >();
  expectTypeOf(inspectNode).toEqualTypeOf<
    (cwd: string, query: InspectNodeQuery) => ResultAsync<RunInspectionNodeDocument, RunInspectionError>
  >();
  expectTypeOf(inspectAgentExecution).toEqualTypeOf<
    (cwd: string, query: InspectAgentExecutionQuery) => ResultAsync<RunInspectionAgentExecutionDocument, RunInspectionError>
  >();
  expectTypeOf(inspectTargetArtifacts).toEqualTypeOf<
    (cwd: string, query: InspectTargetArtifactsQuery) => ResultAsync<RunInspectionTargetArtifactsDocument, RunInspectionError>
  >();

  expectTypeOf<InspectionViewQuery>().toEqualTypeOf<
    | { kind: "run"; runId: string }
    | { kind: "target"; runId: string; target: string; detail: "summary" | "timeline" }
  >();
  expectTypeOf<ReadInspectionQuery>().toEqualTypeOf<{
    view: InspectionViewQuery;
    candidatePage?: number;
  }>();
  expectTypeOf<ObserveInspectionQuery>().toEqualTypeOf<{
    view: InspectionViewQuery;
    until: "subject-terminal" | "decision-boundary";
    signal?: AbortSignal;
  }>();
  expectTypeOf<InspectionRead>().toEqualTypeOf<InspectionView | InspectionCandidates>();
  expectTypeOf<InspectionCandidates>().toMatchTypeOf<{
    kind: "candidates";
    target: string;
    entries: Array<{ selector: string; status: RunInspectionStatus; breadcrumb: string }>;
    page: number;
    total: number;
    nextPage?: number;
  }>();
  expectTypeOf<"limit">().not.toMatchTypeOf<keyof InspectionCandidates>();
  expectTypeOf<Extract<InspectionView, { kind: "run" }>>().toMatchTypeOf<{
    run: { id: string; status: string };
    counts: { total: number };
    tree: unknown[];
  }>();
  expectTypeOf<NonNullable<Extract<InspectionView, { kind: "run" }>["run"]["fork"]>>().toEqualTypeOf<{
    sourceRunId: string;
  }>();
  expectTypeOf<Extract<InspectionView, { kind: "target"; detail: "timeline" }>>().toMatchTypeOf<{
    subject: { label: string; kind: string; selector?: string };
    recent: unknown[];
  }>();
  expectTypeOf<Extract<InspectionObservation, { kind: "update" }>["changes"][number]>().toMatchTypeOf<{
    subject: { label: string; selector?: string };
    state: { status: RunInspectionStatus };
    reason?: "retry" | "steer" | "resume" | "operator-cancelled" | "parent-cancelled" | "branch-selected" | "race-selected" | "quorum-selected" | "superseded";
  }>();
  expectTypeOf<Extract<InspectionObservation, { kind: "closed" }>>().toEqualTypeOf<{
    kind: "closed";
    reason: "subject-terminal" | "awaiting-input" | "paused";
    view: InspectionView;
  }>();
  expectTypeOf<InspectionError>().toEqualTypeOf<
    | { type: "runtime-store-not-found"; message: string }
    | { type: "run-not-found"; runId: string; message: string }
    | { type: "target-not-found"; runId: string; target: string; message: string }
    | { type: "target-ambiguous"; runId: string; target: string; candidates: InspectionCandidates; message: string }
    | { type: "invalid-query"; message: string }
    | { type: "read-failed"; runId: string; message: string }
  >();
});

test("@acpus/runtime retains its baseline runtime and daemon contracts", () => {
  expectTypeOf(listRuns).toEqualTypeOf<(cwd: string) => Promise<RunRecord[]>>();
  expectTypeOf(listArtifacts).toEqualTypeOf<(cwd: string, runId: string) => Promise<ArtifactRecord[] | undefined>>();
  expectTypeOf(resolveArtifact).toEqualTypeOf<
    (cwd: string, artifactRef: string) => ResultAsync<ResolvedArtifact, ArtifactResolutionFailure>
  >();
  expectTypeOf<ResolvedArtifact>().toEqualTypeOf<ArtifactRecord & { uri: string }>();
  expectTypeOf<ArtifactResolutionFailure>().toEqualTypeOf<
    | { type: "invalid-artifact-ref"; message: string }
    | { type: "artifact-not-found"; runId: string; artifactId: string; message: string }
    | { type: "artifact-path-invalid"; runId: string; artifactId: string; message: string }
  >();
  expectTypeOf(getRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunDetails | undefined>>();
  expectTypeOf(getRuntimeHealth).toEqualTypeOf<(cwd: string) => Promise<RuntimeHealthReport>>();
  expectTypeOf(getRunVisualizationSnapshot).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunVisualizationSnapshot | undefined>>();
  expectTypeOf(tryNormalizeForkInput).toEqualTypeOf<
    (cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow) => ResultAsync<JsonValue | undefined, ForkInputNormalizationFailure>
  >();
  expectTypeOf(tryNormalizeWorkflowInput).toEqualTypeOf<
    (ir: WorkflowIR, input: JsonValue, label?: string) => Result<JsonValue, SchemaNormalizationFailure>
  >();
  expectTypeOf(tryValidateAgentOverrides).toEqualTypeOf<
    (ir: WorkflowIR, input: AgentOverrideMap | undefined) => Result<AgentOverrideMap, AgentOverrideValidationFailure>
  >();
  expectTypeOf<AdmitRunFailure>().toEqualTypeOf<
    PreparedRunValidationFailure | SchemaNormalizationFailure | AgentOverrideValidationFailure
  >();
  expectTypeOf(deleteRun).toEqualTypeOf<(cwd: string, runId: string) => ResultAsync<RunRecord | undefined, RunDeleteFailure>>();

  expectTypeOf<DaemonLoopOptions>().toEqualTypeOf<{
    heartbeatMs?: number;
    packageVersion: string;
    idleStopMs?: number;
    onShutdown?: () => void;
    onRunIncident?: (incident: RunIncident) => void;
  }>();
  expectTypeOf(startDaemonLoop).toEqualTypeOf<(cwd: string, options: DaemonLoopOptions) => Promise<DaemonLoopHandle>>();
  expectTypeOf(tryLoadRuntimeConfiguration).toEqualTypeOf<
    (env: NodeJS.ProcessEnv) => Result<RuntimeConfiguration, RuntimeConfigurationFailure>
  >();
  expectTypeOf<RuntimeConfiguration>().toEqualTypeOf<{
    runMaxLeafConcurrency: number;
    agentHostPolicy: AgentHostPolicy;
  }>();
  expectTypeOf<AgentHostPolicy["responseRepair"]>().toEqualTypeOf<
    | { type: "valid"; max: number }
    | { type: "invalid"; failure: AgentHostPolicyFailure }
  >();
  expectTypeOf<AgentHostPolicy["inactivityFailAfterMs"]>().toEqualTypeOf<number | undefined>();

  expectTypeOf<typeof DAEMON_PROTOCOL_VERSION>().toEqualTypeOf<3>();
  expectTypeOf(daemonEndpoint).toEqualTypeOf<(cwd: string) => string>();
  expectTypeOf(requestDaemonStatus).toEqualTypeOf<(cwd: string) => ResultAsync<DaemonStatus, DaemonClientFailure>>();
  expectTypeOf(requestDaemonAdmitRun).toEqualTypeOf<
    (cwd: string, input: DaemonAdmitRunInput) => ResultAsync<RunDetails, DaemonClientFailure>
  >();
  expectTypeOf(requestDaemonControl).toEqualTypeOf<
    (cwd: string, control: DaemonControlIntent) => ResultAsync<DaemonControlResult, DaemonClientFailure>
  >();
  expectTypeOf(requestDaemonShutdown).toEqualTypeOf<
    (cwd: string) => ResultAsync<DaemonShutdownResult, DaemonClientFailure>
  >();
  expectTypeOf(createWorkflowVisualizationOverlay).toMatchTypeOf<
    (ir: WorkflowIR, dynamic?: RunDynamicDetails, options?: { runId?: string; status?: string }) => WorkflowVisualizationOverlay
  >();

  expectTypeOf<PreparedRunWorkflow["lock"]>().toEqualTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<WorkflowSourceFile>().toEqualTypeOf<{ path: string; content: string }>();
  expectTypeOf<WorkflowSourceBundle>().toEqualTypeOf<{
    kind: "acpus_workflow_source_bundle";
    version: 1;
    files: readonly WorkflowSourceFile[];
  }>();
  expectTypeOf<WorkflowSourceRef>().toEqualTypeOf<
    | { kind: "workspace"; entry: string }
    | { kind: "snapshot"; entry: string; digest: Sha256Digest }
  >();
  expectTypeOf<Extract<PreparedRunWorkflow, { source: { kind: "workspace" } }>["sourceBundle"]>().toEqualTypeOf<undefined>();
  expectTypeOf<Extract<PreparedRunWorkflow, { source: { kind: "snapshot" } }>["sourceBundle"]>().toEqualTypeOf<WorkflowSourceBundle>();
  expectTypeOf<CompilerPreparedWorkflow>().toMatchTypeOf<PreparedRunWorkflow>();
  expectTypeOf<PreparedRunWorkflow>().toMatchTypeOf<CompilerPreparedWorkflow>();
  expectTypeOf<CompilerWorkflowPreparationLock>().toMatchTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<RunWorkflowLockArtifact>().toMatchTypeOf<CompilerWorkflowPreparationLock>();
  expectTypeOf<CompilerWorkflowSourceRef>().toMatchTypeOf<WorkflowSourceRef>();
  expectTypeOf<WorkflowSourceRef>().toMatchTypeOf<CompilerWorkflowSourceRef>();
  expectTypeOf<CompilerWorkflowSourceBundle>().toMatchTypeOf<WorkflowSourceBundle>();
  expectTypeOf<WorkflowSourceBundle>().toMatchTypeOf<CompilerWorkflowSourceBundle>();
  expectTypeOf<CompilerWorkflowSourceFile>().toMatchTypeOf<WorkflowSourceFile>();
  expectTypeOf<WorkflowSourceFile>().toMatchTypeOf<CompilerWorkflowSourceFile>();
  expectTypeOf<CompilerSha256Digest>().toMatchTypeOf<Sha256Digest>();
  expectTypeOf<Sha256Digest>().toMatchTypeOf<CompilerSha256Digest>();

  expectTypeOf<RunDetails>().toMatchTypeOf<RunRecord>();
  expectTypeOf<RunDetails["fork"]>().toEqualTypeOf<RunForkInfo | undefined>();
  expectTypeOf<RunForkInfo>().toEqualTypeOf<{ sourceRunId: string; target?: string }>();
  expectTypeOf<NonNullable<RunDetails["dynamic"]>>().toEqualTypeOf<RunDynamicDetails>();
  expectTypeOf<RunDynamicDetails["frames"][number]>().toEqualTypeOf<RunDynamicFrame>();
  expectTypeOf<RunDynamicDetails["nodeInstances"][number]>().toEqualTypeOf<RunDynamicNodeInstance>();
  expectTypeOf<RunDynamicDetails["attempts"][number]>().toEqualTypeOf<RunDynamicAttempt>();
  expectTypeOf<RunDynamicDetails["groupMembers"][number]>().toEqualTypeOf<RunDynamicGroupMember>();
  expectTypeOf<RunDynamicDetails["signalWaits"][number]>().toEqualTypeOf<RunDynamicSignalWait>();
  expectTypeOf<RunDynamicSignalWait>().toMatchTypeOf<{ payload?: JsonValue; consumedAt?: string }>();
  expectTypeOf<RunDynamicDetails["progress"][number]>().toEqualTypeOf<RunNodeProgress>();
  expectTypeOf<RunDynamicDetails["progressVersion"]>().toEqualTypeOf<number>();
  expectTypeOf<RunRecord["progressVersion"]>().toEqualTypeOf<number>();
  expectTypeOf<RunNodeProgress>().toMatchTypeOf<{
    nodeKey: string;
    nodeId: string;
    attemptId?: string;
    attemptNo?: number;
    kind: string;
    status: string;
    message?: string;
    output?: { tail: string; totalBytes: number; truncated: boolean };
    context?: unknown;
    tokenUsage?: unknown;
    tools?: unknown;
    intent?: unknown;
    updatedAt: string;
  }>();
  expectTypeOf<NonNullable<RunDynamicFrame["instancePath"]>[number]>().toMatchTypeOf<{ kind: string }>();
  expectTypeOf<NonNullable<RunDynamicNodeInstance["instancePath"]>[number]>().toMatchTypeOf<{ kind: string }>();
  expectTypeOf<RunDynamicNodeInstance>().toMatchTypeOf<{
    reusedFromRunId?: string;
    reusedFromNodeKey?: string;
  }>();
  expectTypeOf<undefined>().toMatchTypeOf<RunDynamicFrame["instancePath"]>();
  expectTypeOf<undefined>().toMatchTypeOf<RunDynamicNodeInstance["instancePath"]>();
  expectTypeOf<RunDynamicGroupMember["completionSequence"]>().toEqualTypeOf<number | undefined>();
  expectTypeOf<RunStatus>().toEqualTypeOf<"pending" | "running" | "paused" | "awaiting" | "failed" | "completed" | "canceled">();

  expectTypeOf<DaemonStatus>().toMatchTypeOf<{
    status: "ok";
    pid: number;
    generation: number;
    protocolVersion: number;
    packageVersion: string;
  }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "pause" | "resume" }>>().toEqualTypeOf<{
    requestId: string;
    type: "pause" | "resume";
    runId: string;
  }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "retry" | "cancel" }>>().toEqualTypeOf<{
    requestId: string;
    type: "retry" | "cancel";
    runId: string;
    target?: string;
  }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "steer" }>>().toEqualTypeOf<{
    requestId: string;
    type: "steer";
    runId: string;
    target: string;
    instruction: string;
  }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "fork" }>>().toMatchTypeOf<{
    requestId: string;
    type: "fork";
    runId: string;
    target?: string;
    input?: JsonValue;
  }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "signal" }>>().toEqualTypeOf<{
    requestId: string;
    type: "signal";
    runId: string;
    nodeId: string;
    payload: JsonValue;
  }>();
  expectTypeOf<DaemonControlResult>().toEqualTypeOf<
    | { type: "pause"; state: "applied"; run: RunDetails }
    | { type: "resume"; state: "applied"; run: RunDetails }
    | { type: "retry"; state: "applied"; run: RunDetails; target?: string }
    | { type: "cancel"; state: "applied"; run: RunDetails; target?: string }
    | {
      type: "steer";
      state: "applied";
      run: RunDetails;
      steerId: string;
      requestedTarget: string;
      target: string;
      fencedAttemptId: string;
      continuation: "queued";
    }
    | { type: "fork"; state: "applied"; sourceRunId: string; run: RunDetails }
    | {
      type: "signal";
      state: "consumed";
      requestedTarget: string;
      target: string;
      validation: { kind: "schema"; schemaSummary: string } | { kind: "raw-string" };
      run: RunDetails;
    }
  >();

  expectTypeOf<WorkflowVisualizationOverlay["nodes"][number]>().toEqualTypeOf<WorkflowVisualizationNode>();
  expectTypeOf<WorkflowVisualizationOverlay["groups"][number]>().toEqualTypeOf<WorkflowVisualizationGroup>();
  expectTypeOf<RuntimeHealthReport["checks"][number]>().toEqualTypeOf<RuntimeHealthCheck>();
  expectTypeOf<RuntimeHealthReport["persistence"]>().toEqualTypeOf<RuntimePersistence | undefined>();
  expectTypeOf<Extract<RuntimeHealthReport, { state: "not-initialized" }>["persistence"]>().toEqualTypeOf<RuntimePersistence>();
  expectTypeOf<Extract<RuntimeHealthReport, { state: "ready" }>["persistence"]>().toEqualTypeOf<RuntimePersistence>();
  expectTypeOf<RuntimePersistence>().toEqualTypeOf<{ path: string }>();
  expectTypeOf<AgentOutputProcessing>().toEqualTypeOf<
    | { outcome: "accepted"; parsing: "direct" | "repaired"; projectionChanged: boolean }
    | { outcome: "rejected"; phase: "framing" | "json" }
    | { outcome: "rejected"; phase: "schema"; parsing: "direct" | "repaired"; projectionChanged: boolean }
  >();
  expectTypeOf<AgentTurnArtifact>().toEqualTypeOf<{
    schemaVersion: 2;
    runId: string;
    nodeId: string;
    nodeKey: string;
    attemptNo: number;
    turn: number;
    agentKey: string;
    sessionName: string;
    sessionProjectionPath?: string;
    timing: import("@acpus/agent-executor").AgentTurnTiming;
    prompt: string;
    responses: string[];
    summary: AgentTurnSummary;
  } & (
    | { status: "completed"; finalResponse: string }
    | { status: "failed"; failure: import("@acpus/agent-executor").AgentBackendFailure }
    | { status: "cancelled"; message: string }
  )>();
  expectTypeOf<RunInspectionDetailedFailure>().toMatchTypeOf<{
    origin: string;
    message: string;
    upstream?: { source: "acpx"; data?: JsonValue };
  }>();
});
