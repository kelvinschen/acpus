import { expectTypeOf, test } from "vitest";
import {
  DAEMON_PROTOCOL_VERSION,
  RUNTIME_ABI_VERSION,
  createWorkflowVisualizationOverlay,
  daemonEndpoint,
  deleteRun,
  getArtifact,
  getRun,
  getRuntimeHealth,
  getRunVisualizationSnapshot,
  inspectAgentExecution,
  inspectNode,
  inspectRuntimeStore,
  inspectTargetArtifacts,
  listArtifacts,
  listKnownWorkspaces,
  listRuns,
  observeInspection,
  resolveArtifact,
  resolveKnownWorkspace,
  readInspection,
  readArtifact,
  repairRuntimeStore,
  requestDaemonControl,
  requestDaemonStatusProbe,
  requestDaemonSubmitAndObserve,
  requestPredecessorDaemonShutdown,
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
  ArchivedRunInspection,
  DaemonClientFailure,
  DaemonControlIntent,
  DaemonControlResult,
  DaemonLoopHandle,
  DaemonLoopOptions,
  DaemonPredecessorStatus,
  DaemonRunObservationUntil,
  DaemonRunStreamClientFailure,
  DaemonRunStreamFrame,
  DaemonShutdownResult,
  DaemonStatus,
  DaemonStatusProbe,
  DaemonSubmitAndObserveInput,
  ForkInputNormalizationFailure,
  InspectAgentExecutionQuery,
  InspectionAttention,
  InspectionCandidates,
  InspectionChange,
  InspectionCounts,
  InspectionError,
  InspectionForensicsView,
  InspectionObservation,
  InspectionRead,
  InspectionToolActivity,
  InspectionAgentTelemetry,
  InspectionTreeAgent,
  InspectionView,
  InspectionViewQuery,
  InspectionVisibility,
  KnownWorkspace,
  KnownWorkspaceListing,
  InspectNodeQuery,
  InspectTargetArtifactsQuery,
  ObserveInspectionQuery,
  ObservableInspectionViewQuery,
  PreparedRunValidationFailure,
  PreparedRunWorkflow,
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
  RuntimeReadFailure,
  RuntimeAuthorityIdentity,
  RuntimeStoreFailure,
  RuntimeStoreStatus,
  ResolvedArtifact,
  SchemaNormalizationFailure,
  Sha256Digest,
  WorkflowSourceBundle,
  WorkflowSourceFile,
  WorkflowSourceRef,
  WorkflowVisualizationGroup,
  WorkflowVisualizationNode,
  WorkflowVisualizationOverlay,
  WorkspaceResolutionFailure,
} from "@acpus/runtime";
import {
  openWorkspaceRuntime,
  type NamedAcpAgentLaunchRegistry,
  type NamedAcpAgentLaunchResolver,
  type WorkspaceRuntime,
  type WorkspaceRuntimeHostDependencies,
  type WorkspaceRuntimeLocation,
  type WorkspaceRuntimeOpenFailure,
} from "@acpus/runtime/host";
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
    (cwd: string, view: InspectionViewQuery) => ResultAsync<InspectionRead, InspectionError>
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
    | { kind: "run"; runId: string; structure?: "materialized" }
    | { kind: "target"; runId: string; target: string; detail: "summary" | "timeline" | "forensics" }
  >();
  expectTypeOf<ObservableInspectionViewQuery>().toEqualTypeOf<
    | { kind: "run"; runId: string; structure?: "materialized" }
    | { kind: "target"; runId: string; target: string; detail: "summary" | "timeline" }
  >();
  expectTypeOf<ObserveInspectionQuery>().toEqualTypeOf<{
    view: ObservableInspectionViewQuery;
    until: "subject-terminal" | "decision-boundary";
    updates?: "decision" | "activity";
    signal?: AbortSignal;
  }>();
  expectTypeOf<InspectionRead>().toEqualTypeOf<InspectionView | InspectionCandidates | ArchivedRunInspection>();
  expectTypeOf<InspectionToolActivity>().toEqualTypeOf<{
    name: string;
    title?: string;
    state: "running" | "completed" | "failed" | "canceled";
  }>();
  expectTypeOf<InspectionAgentTelemetry>().toEqualTypeOf<{
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    contextWindow?: { used: number; size: number };
  }>();
  expectTypeOf<InspectionTreeAgent>().toEqualTypeOf<{
    name: string;
    telemetry?: InspectionAgentTelemetry;
  }>();
  expectTypeOf<InspectionCandidates>().toEqualTypeOf<{
    kind: "candidates";
    run: { id: string; status: RunStatus };
    target: string;
    entries: Array<{ selector: string; status: RunInspectionStatus; breadcrumb: string }>;
  }>();
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
  expectTypeOf<Extract<InspectionView, { kind: "target"; detail: "forensics" }>>().toMatchTypeOf<{
    definition: { kind: string };
    invocation: { status: "resolved" | "unavailable" };
    result: { status: "accepted" | "completed_without_output" | "pending" | "not_started" | "not_selected" | "failed" | "timed_out" | "cancelled" | "not_accepted" };
  }>();
  expectTypeOf<InspectionForensicsView>().toEqualTypeOf<Extract<InspectionView, { kind: "target"; detail: "forensics" }>>();
  expectTypeOf<Extract<InspectionObservation, { kind: "update" }>["changes"][number]>().toMatchTypeOf<{
    subject: { label: string; kind: string; selector?: string };
    state: { status: RunInspectionStatus };
    occurrences?: InspectionCounts;
    attention?: InspectionAttention;
    visibility?: InspectionVisibility;
    reason?: "retry" | "steer" | "resume" | "operator-cancelled" | "parent-cancelled" | "branch-selected" | "race-selected" | "quorum-selected" | "superseded";
  }>();
  expectTypeOf<InspectionChange>().toMatchTypeOf<Extract<InspectionObservation, { kind: "update" }>["changes"][number]>();
  expectTypeOf<InspectionVisibility>().toEqualTypeOf<{
    state: "degraded";
    reason: "observation-gap" | "unrecognized-provider-activity";
  }>();
  expectTypeOf<Extract<InspectionObservation, { kind: "closed" }>>().toEqualTypeOf<{
    kind: "closed";
    reason: "subject-terminal" | "awaiting-input" | "paused";
    view: InspectionView;
  }>();
  expectTypeOf<InspectionError>().toEqualTypeOf<
    | { type: "runtime-store-not-found"; message: string }
    | {
        type: "runtime-store-repair-required";
        runId: string;
        message: string;
      }
    | {
        type: "runtime-store-unsupported";
        runId: string;
        message: string;
      }
    | {
        type: "runtime-store-unavailable";
        runId: string;
        message: string;
      }
    | { type: "archived-run-detail-unavailable"; runId: string; command: string; message: string }
    | { type: "archived-run-lookup-unavailable"; runId: string; message: string }
    | { type: "run-not-found"; runId: string; message: string }
    | { type: "target-not-found"; runId: string; target: string; message: string }
    | { type: "target-ambiguous"; runId: string; target: string; candidates: InspectionCandidates; message: string }
    | { type: "invalid-query"; message: string }
    | { type: "read-failed"; runId: string; message: string }
  >();
});

test("@acpus/runtime/host exposes the embeddable Runtime interface", () => {
  expectTypeOf(openWorkspaceRuntime).toEqualTypeOf<
    (
      location: WorkspaceRuntimeLocation,
      dependencies?: WorkspaceRuntimeHostDependencies,
    ) => ResultAsync<WorkspaceRuntime, WorkspaceRuntimeOpenFailure>
  >();
  expectTypeOf<WorkspaceRuntimeLocation>().toEqualTypeOf<Readonly<{
    workspace: string;
    stateRoot: string;
  }>>();
  expectTypeOf<WorkspaceRuntimeHostDependencies>().toEqualTypeOf<Readonly<{
    namedAgentLaunches?: NamedAcpAgentLaunchRegistry;
  }>>();
  expectTypeOf<WorkspaceRuntimeOpenFailure>().toEqualTypeOf<
    | { type: "runtime-store-unsupported" | "runtime-store-unavailable"; message: string }
    | { type: "runtime-authority-busy"; pid?: number; message: string }
    | { type: "runtime-configuration-invalid" | "runtime-open-failed"; message: string }
  >();
  expectTypeOf<NamedAcpAgentLaunchResolver>().toEqualTypeOf<
    (input: Readonly<{ model?: string }>) => readonly string[]
  >();
  expectTypeOf<WorkspaceRuntime["findAdmission"]>().toEqualTypeOf<
    (requestId: string) => ResultAsync<RunDetails | undefined, RuntimeReadFailure>
  >();
});

test("@acpus/runtime retains its baseline runtime and daemon contracts", () => {
  expectTypeOf(listKnownWorkspaces).toEqualTypeOf<(cwd: string) => Promise<KnownWorkspaceListing>>();
  expectTypeOf(resolveKnownWorkspace).toEqualTypeOf<
    (cwd: string, workspaceKey: string) => ResultAsync<
      { workspaceKey: string; canonicalPath: string },
      WorkspaceResolutionFailure
    >
  >();
  expectTypeOf<KnownWorkspace>().toEqualTypeOf<{
    workspaceKey: string;
    canonicalPath: string;
    runCount?: number;
    lastRunUpdatedAt?: string;
  }>();
  expectTypeOf<KnownWorkspaceListing>().toEqualTypeOf<{
    currentWorkspaceKey: string;
    workspaces: KnownWorkspace[];
    failures: Array<{ workspaceKey: string; message: string }>;
  }>();
  expectTypeOf<WorkspaceResolutionFailure>().toEqualTypeOf<
    | { type: "workspace-key-invalid"; workspaceKey: string; message: string }
    | { type: "workspace-not-found"; workspaceKey: string; message: string }
    | { type: "workspace-unavailable"; workspaceKey: string; message: string }
  >();
  expectTypeOf<RuntimeReadFailure>().toEqualTypeOf<
    | {
        type: "runtime-store-repair-required";
        message: string;
      }
    | { type: "runtime-store-unsupported"; message: string }
    | { type: "runtime-store-unavailable"; message: string }
  >();
  expectTypeOf(listRuns).toEqualTypeOf<(cwd: string) => ResultAsync<RunRecord[], RuntimeReadFailure>>();
  expectTypeOf(listArtifacts).toEqualTypeOf<
    (cwd: string, runId: string) => ResultAsync<ArtifactRecord[] | undefined, RuntimeReadFailure>
  >();
  expectTypeOf(getArtifact).toEqualTypeOf<
    (cwd: string, runId: string, artifactId: string) => ResultAsync<ArtifactRecord | undefined, RuntimeReadFailure>
  >();
  expectTypeOf(readArtifact).toEqualTypeOf<
    (cwd: string, runId: string, artifactId: string) => ResultAsync<
      { artifact: ArtifactRecord; bytes: Buffer } | undefined,
      RuntimeReadFailure
    >
  >();
  expectTypeOf(resolveArtifact).toEqualTypeOf<
    (cwd: string, artifactRef: string) => ResultAsync<ResolvedArtifact, ArtifactResolutionFailure | RuntimeReadFailure>
  >();
  expectTypeOf<ResolvedArtifact>().toEqualTypeOf<ArtifactRecord & { uri: string }>();
  expectTypeOf<ArtifactResolutionFailure>().toEqualTypeOf<
    | { type: "invalid-artifact-ref"; message: string }
    | { type: "artifact-not-found"; runId: string; artifactId: string; message: string }
    | { type: "artifact-path-invalid"; runId: string; artifactId: string; message: string }
  >();
  expectTypeOf(getRun).toEqualTypeOf<
    (cwd: string, runId: string) => ResultAsync<RunDetails | undefined, RuntimeReadFailure>
  >();
  expectTypeOf(getRuntimeHealth).toEqualTypeOf<(cwd: string) => Promise<RuntimeHealthReport>>();
  expectTypeOf(getRunVisualizationSnapshot).toEqualTypeOf<
    (cwd: string, runId: string) => ResultAsync<RunVisualizationSnapshot | undefined, RuntimeReadFailure>
  >();
  expectTypeOf(tryNormalizeForkInput).toEqualTypeOf<
    (cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow) => ResultAsync<
      JsonValue | undefined,
      ForkInputNormalizationFailure | RuntimeReadFailure
    >
  >();
  expectTypeOf(tryNormalizeWorkflowInput).toEqualTypeOf<
    (ir: WorkflowIR, input: JsonValue, label?: string) => Result<JsonValue, SchemaNormalizationFailure>
  >();
  expectTypeOf(tryValidateAgentOverrides).toEqualTypeOf<
    (ir: WorkflowIR, input: AgentOverrideMap | undefined) => Result<AgentOverrideMap, AgentOverrideValidationFailure>
  >();
  expectTypeOf<AdmitRunFailure>().toEqualTypeOf<
    | PreparedRunValidationFailure
    | SchemaNormalizationFailure
    | AgentOverrideValidationFailure
    | { type: "admission-request-conflict"; requestId: string; message: string }
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

  expectTypeOf<typeof DAEMON_PROTOCOL_VERSION>().toEqualTypeOf<4>();
  expectTypeOf<typeof RUNTIME_ABI_VERSION>().toEqualTypeOf<1>();
  expectTypeOf(daemonEndpoint).toEqualTypeOf<(cwd: string) => string>();
  expectTypeOf(requestDaemonStatus).toEqualTypeOf<(cwd: string) => ResultAsync<DaemonStatus, DaemonClientFailure>>();
  expectTypeOf(requestDaemonStatusProbe).toEqualTypeOf<
    (cwd: string) => ResultAsync<DaemonStatusProbe, DaemonClientFailure>
  >();
  expectTypeOf(requestDaemonSubmitAndObserve).toEqualTypeOf<
    (
      cwd: string,
      input: DaemonSubmitAndObserveInput,
      options?: { signal?: AbortSignal },
    ) => AsyncIterable<Result<DaemonRunStreamFrame, DaemonRunStreamClientFailure>>
  >();
  expectTypeOf(requestDaemonControl).toEqualTypeOf<
    (cwd: string, control: DaemonControlIntent) => ResultAsync<DaemonControlResult, DaemonClientFailure>
  >();
  expectTypeOf(requestDaemonShutdown).toEqualTypeOf<
    (cwd: string) => ResultAsync<DaemonShutdownResult, DaemonClientFailure>
  >();
  expectTypeOf(requestPredecessorDaemonShutdown).toEqualTypeOf<
    (cwd: string) => ResultAsync<DaemonShutdownResult, DaemonClientFailure>
  >();
  expectTypeOf<DaemonStatus>().toEqualTypeOf<{
    status: "ok";
    pid: number;
    leaseGeneration: number;
    protocolVersion: 4;
    packageVersion: string;
    authority: RuntimeAuthorityIdentity;
  }>();
  expectTypeOf<DaemonPredecessorStatus>().toEqualTypeOf<{
    status: "ok";
    pid: number;
    generation: number;
    protocolVersion: 3;
    packageVersion: string;
  }>();
  expectTypeOf<DaemonRunObservationUntil>().toEqualTypeOf<"admitted" | "subject-terminal" | "decision-boundary">();
  expectTypeOf<RuntimeAuthorityIdentity>().toEqualTypeOf<{
    workspaceKey: string;
    runtimeAbi: 1;
    layoutVersion: 2;
    storageVersion: 10;
    authorityId: string;
    storeBinding: `sha256:${string}`;
    leaseGeneration: number;
  }>();
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
  expectTypeOf<CompilerPreparedWorkflow>().toEqualTypeOf<PreparedRunWorkflow>();
  expectTypeOf<CompilerWorkflowPreparationLock>().toEqualTypeOf<RunWorkflowLockArtifact>();
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

test("@acpus/runtime exposes a minimal Runtime store repair interface", () => {
  expectTypeOf(inspectRuntimeStore).toEqualTypeOf<
    (cwd: string) => ResultAsync<RuntimeStoreStatus, RuntimeStoreFailure>
  >();
  expectTypeOf(repairRuntimeStore).toEqualTypeOf<
    (cwd: string) => ResultAsync<{ changed: boolean }, RuntimeStoreFailure>
  >();
  expectTypeOf<RuntimeStoreStatus>().toEqualTypeOf<
    | { state: "ready" }
    | { state: "repairable"; message: string }
    | { state: "unsupported"; message: string }
  >();
  expectTypeOf<RuntimeStoreFailure>().toEqualTypeOf<{
    type: "busy" | "unsupported" | "unreadable" | "failed";
    message: string;
  }>();
});
