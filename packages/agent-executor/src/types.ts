import type { AcpError, AcpEvent, AcpLaunch, AcpTurnResult } from "@acpus/acp";
import type { Result, ResultAsync } from "neverthrow";
import type { AcpAgentResolutionFailure } from "./agent-resolution.js";

export type AgentPermissionMode = "approve-reads" | "approve-all" | "deny-all";

export type AgentSelector =
  | { kind: "named"; name: string }
  | { kind: "command"; command: string };

export type AcpAgentLaunch = AcpLaunch;

export type NamedAcpAgentLaunchResolver = (input: Readonly<{
  model?: string;
}>) => readonly string[];

export type NamedAcpAgentLaunchRegistry = Readonly<
  Record<string, NamedAcpAgentLaunchResolver>
>;

export type ConfiguredAcpAgentCommandResolver = (
  names: readonly string[],
) => ResultAsync<string | undefined, AcpAgentResolutionFailure>;

export type AgentToolInputPreview = {
  preview: string;
  truncated: boolean;
  originalBytes: number;
  headBytes: number;
  tailBytes?: number;
};

export type AgentContextSummary = {
  used: number;
  size: number;
  updatedAt: string;
};

export type AgentTokenUsageSummary = {
  source: "prompt_response" | "usage_update";
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

export type AgentTelemetryAvailability = {
  context: "available" | "unavailable";
  tokenUsage: "available" | "partial" | "unavailable";
};

export type AgentToolCallSummary = {
  toolCallId: string;
  title?: string;
  kind?: string;
  toolName?: string;
  status?: string;
  input?: AgentToolInputPreview;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type AgentToolsSummary = {
  totalToolCallCount: number;
  calls: AgentToolCallSummary[];
};

export type AgentTurnSummary = {
  eventCount: number;
  availability: AgentTelemetryAvailability;
  stopReason?: string;
  context?: AgentContextSummary;
  tokenUsage?: AgentTokenUsageSummary;
  tools: AgentToolsSummary;
};

export type AgentTurnTiming = {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
};

export type RuntimeOwnerIdentity = Readonly<{
  epoch: number;
  pid: number;
  startToken?: string;
}>;

export type AgentSessionSupervisorOptions = Readonly<{
  workersRoot: string;
  sessionStateDirectoryForRun(runId: string): string;
  owner: RuntimeOwnerIdentity;
  namedAgentLaunches?: NamedAcpAgentLaunchRegistry;
  configuredAgentCommand?: ConfiguredAcpAgentCommandResolver;
}>;

export type AgentSessionRef = Readonly<{
  runId: string;
  agentSessionId: string;
}>;

export type AttemptContext = Readonly<{
  runId: string;
  nodeKey: string;
  attemptId: string;
  ownerEpoch: number;
  deadlineAt?: string;
  signal: AbortSignal;
  inactivityFailAfterMs?: number;
}>;

export type AgentSessionIntent = Readonly<{
  agentSessionId: string;
  sessionOpenMode: "new_or_empty" | "existing_required";
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  agent: AgentSelector;
  permissionMode: AgentPermissionMode;
  configuration: Readonly<{
    model?: string;
    options: Readonly<Record<string, string>>;
  }>;
}>;

export type AgentTurnSnapshot = Readonly<{
  responses: readonly string[];
  summary: AgentTurnSummary;
  timing: AgentTurnTiming;
}>;

export type AgentTurnEvent = Readonly<{
  sequence: number;
  observedAt: string;
  elapsedMs: number;
  event: AcpEvent;
}>;

export type AgentTurnPolicyEvidence =
  | Readonly<{
      type: "cancelled";
      reason: "operator" | "pause" | "lease_lost" | "steer" | "event_sink";
      requestedAt: string;
    }>
  | Readonly<{
      type: "deadline";
      deadlineAt: string;
      requestedAt: string;
    }>
  | Readonly<{
      type: "inactivity";
      failAfterMs: number;
      silentForMs: number;
      silenceStartedAt: string;
      requestedAt: string;
    }>;

export type HardCleanupEvidence = Readonly<{
  disposition: "cooperative" | "term" | "kill" | "unverified";
  startedAt: string;
  finishedAt: string;
}>;

export type AgentTurnSettlementEvidence = Readonly<{
  policy?: AgentTurnPolicyEvidence;
  protocolTerminal?:
    | Readonly<{ type: "provider_result"; result: AcpTurnResult }>
    | Readonly<{ type: "provider_error_response"; error: AcpError }>;
  localFailure?: Readonly<{ type: "local_error"; error: AcpError }>;
  hardCleanup?: HardCleanupEvidence;
}>;

export type TurnInput<E> = Readonly<{
  turnId: string;
  prompt: string;
  onEvent: (event: AgentTurnEvent) => Result<void, E>;
}>;

export type AgentTurnOutcome = Readonly<{
  terminal: AcpTurnResult & Readonly<{ status: "completed" }>;
  finalResponse: string;
  snapshot: AgentTurnSnapshot;
}>;

export type AgentTurnFailure<E> = Readonly<{
  snapshot: AgentTurnSnapshot;
  evidence: AgentTurnSettlementEvidence;
}> & (
  | Readonly<{ type: "cancelled"; reason: "operator" | "pause" | "lease_lost" | "steer" | "provider" }>
  | Readonly<{ type: "acp"; error: AcpError }>
  | Readonly<{ type: "policy_timeout"; deadlineAt: string }>
  | Readonly<{
      type: "inactivity_stale";
      failAfterMs: number;
      silentForMs: number;
      silenceStartedAt: string;
    }>
  | Readonly<{ type: "capsule_lost"; error: ProcessCapsuleError }>
  | Readonly<{ type: "event_sink"; error: E }>
);

export type AgentSessionLease = Readonly<{
  agentSessionId: string;
  sessionLeaseId: string;
  projectionRef: string;
  reportedVersion?: string;
  runTurn<E>(input: TurnInput<E>): ResultAsync<AgentTurnOutcome, AgentTurnFailure<E>>;
}>;

export type SessionOwnershipEvidence = Readonly<{
  state: "live" | "dead" | "unverified" | "unsupported";
  observedAt: string;
  reason: string;
}>;

export type ProcessCapsuleError = Readonly<{
  type: "process_capsule";
  phase: "bootstrap" | "opening" | "ready" | "running" | "closing";
  code: "worker_spawn_failed" | "worker_exit" | "ipc_closed" | "ipc_protocol" | "worker_exception";
  message: string;
}>;

export type AgentSessionSupervisorStartError =
  | Readonly<{ type: "ownership_state_unsupported"; manifestName: string; message: string }>
  | Readonly<{ type: "startup_recovery_failed"; message: string }>;

export type AgentSessionAcquireError =
  | Readonly<{ type: "supervisor_closed"; agentSessionId?: string; message: string }>
  | Readonly<{ type: "session_busy"; agentSessionId: string; message: string }>
  | Readonly<{
      type: "session_quarantined";
      agentSessionId: string;
      evidence: SessionOwnershipEvidence;
      message: string;
    }>
  | Readonly<{
      type: "ownership_state_unsupported";
      agentSessionId?: string;
      manifestName: string;
      message: string;
    }>
  | Readonly<{
      type: "agent_resolution_failed";
      agentSessionId: string;
      error: AcpAgentResolutionFailure;
      message: string;
    }>
  | Readonly<{ type: "session_open_failed"; agentSessionId: string; error: AcpError; message: string }>
  | Readonly<{ type: "capsule_open_failed"; agentSessionId: string; error: ProcessCapsuleError; message: string }>
  | Readonly<{
      type: "policy_timeout";
      agentSessionId: string;
      phase: "acquire" | "resolve" | "open";
      deadlineAt: string;
      message: string;
    }>
  | Readonly<{
      type: "cancelled";
      agentSessionId: string;
      phase: "acquire" | "resolve" | "open";
      message: string;
    }>;

export type AgentSessionCleanupError =
  | Readonly<{
      type: "cleanup_failed";
      agentSessionId: string;
      evidence: SessionOwnershipEvidence;
      message: string;
    }>
  | Readonly<{
      type: "cleanup_unverified";
      agentSessionId: string;
      evidence: SessionOwnershipEvidence & Readonly<{ state: "unverified" }>;
      message: string;
    }>;

export type AgentSessionShutdownError = Readonly<{
  type: "shutdown_failed";
  errors: readonly AgentSessionCleanupError[];
  message: string;
}>;

export type AgentSessionUseError<E> =
  | Readonly<{ type: "acquire"; error: AgentSessionAcquireError }>
  | Readonly<{ type: "use"; error: E }>
  | Readonly<{ type: "cleanup"; error: AgentSessionCleanupError }>
  | Readonly<{ type: "use_and_cleanup"; use: E; cleanup: AgentSessionCleanupError }>;

export type SessionNeutralizationEvidence = Readonly<{
  session: AgentSessionRef;
  disposition: "already_absent" | "cooperative" | "term" | "kill";
  observedAt: string;
}>;

export type AgentSessionNeutralizationError<E> =
  | Readonly<{ type: "acquire"; error: AgentSessionAcquireError }>
  | Readonly<{ type: "cancelled"; phase: "acquire" | "neutralize"; message: string }>
  | Readonly<{ type: "neutralize"; errors: readonly AgentSessionCleanupError[] }>
  | Readonly<{ type: "commit"; error: E }>;

export type AgentSessionSupervisor = Readonly<{
  withSessionLease<T, E>(
    input: { attempt: AttemptContext; session: AgentSessionIntent },
    use: (lease: AgentSessionLease) => ResultAsync<T, E>,
  ): ResultAsync<T, AgentSessionUseError<E>>;
  withSessionsNeutralized<T, E>(
    input: { sessions: readonly AgentSessionRef[]; signal: AbortSignal },
    commit: (evidence: readonly SessionNeutralizationEvidence[]) => Result<T, E>,
  ): ResultAsync<T, AgentSessionNeutralizationError<E>>;
  shutdown(): ResultAsync<void, AgentSessionShutdownError>;
}>;

export type AcpOwnershipManifest = {
  schemaVersion: 3;
  hostId: string;
  agentSessionId: string;
  sessionLeaseId: string;
  runId: string;
  attemptId: string;
  owner: {
    pid: number;
    startToken?: string;
    epoch: number;
  };
  worker: {
    pid: number;
    startToken?: string;
    pgid?: number;
  };
  state:
    | { phase: "opening" | "ready" | "cleaning" }
    | { phase: "running" | "cancelling"; turnId: string }
    | {
        phase: "degraded";
        previousPhase: "opening" | "ready" | "running" | "cancelling" | "cleaning";
        evidence: {
          reason: "cleanup_unverified" | "startup_recovery_unverified";
          liveness: "live" | "unverified";
          observedAt: string;
        };
      };
  createdAt: string;
};

export type AcpOwnershipHealth = {
  degraded: number;
  orphaned: number;
  manifests: Array<{
    hostId: string;
    agentSessionId: string;
    runId: string;
    attemptId: string;
    state: AcpOwnershipManifest["state"];
    health: "healthy" | "quarantined" | "unverified";
  }>;
};
