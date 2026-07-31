export type AgentPermissionMode = "approve-reads" | "approve-all" | "deny-all";

export type AgentSelector =
  | { kind: "named"; name: string }
  | { kind: "command"; command: string };

export type AgentJsonValue = null | boolean | number | string | AgentJsonValue[] | { [key: string]: AgentJsonValue };

export type AgentBackendFailureKind =
  | "config"
  | "spawn"
  | "provider_exit"
  | "timeout"
  | "worker_lost"
  | "inactivity_stale";

export type AgentBackendFailure = {
  kind: AgentBackendFailureKind;
  origin?: "provider" | "runtime";
  retryable?: boolean;
  message: string;
  evidence?: {
    failAfterMs: number;
    silentForMs: number;
    silenceStartedAt: string;
  };
  upstream?: {
    source: "acpx";
    operation: "sessions.ensure" | "session.set_config_option" | "prompt";
    code?: string;
    origin?: string;
  };
};

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
  cwd?: string;
  acpxRecordId?: string;
};

export type AgentTurnProgress = {
  responses: readonly string[];
  summary: AgentTurnSummary;
  updatedAt: string;
};

type AgentObservationEventBase = {
  schemaVersion: 1;
  sequence: number;
  observedAt: string;
  elapsedMs: number;
};

type AgentObservationEventPayload =
  | { type: "message"; channel: "assistant" | "thought"; content: AgentJsonValue; tag?: string }
  | {
      type: "tool";
      action: "call" | "update";
      toolCallId?: string;
      title?: string;
      kind?: string;
      toolName?: string;
      status?: string;
      rawInput?: AgentJsonValue;
      rawOutput?: AgentJsonValue;
      content?: AgentJsonValue;
      locations?: AgentJsonValue;
    }
  | { type: "usage"; context?: AgentJsonValue; tokenUsage?: AgentJsonValue }
  | { type: "plan"; value: AgentJsonValue }
  | { type: "unknown"; tag?: string; value: AgentJsonValue }
  | {
      type: "turn_end";
      status: "completed" | "failed" | "cancelled" | "timed_out";
      stopReason?: string;
      failure?: AgentJsonValue;
      message?: string;
    };

export type AgentObservationEvent = AgentObservationEventBase & AgentObservationEventPayload;

export type AgentTurnObservation = {
  event: AgentObservationEvent;
  progress: AgentTurnProgress;
};

export type AgentTurnTiming = {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
};

type AgentTurnResultBase = {
  responses: readonly string[];
  stderr: string;
  summary: AgentTurnSummary;
  timing: AgentTurnTiming;
};

export type AgentTurnResult = AgentTurnResultBase & (
  | {
      status: "completed";
      finalResponse: string;
    }
  | {
      status: "failed";
      failure: AgentBackendFailure;
    }
  | {
      status: "cancelled";
      message: string;
    }
);

export type AgentTurnRequest = {
  agent: AgentSelector;
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionName: string;
  permissionMode: AgentPermissionMode;
  model?: string;
  config?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AgentTurnProgress) => unknown;
  onObservation?: (observation: AgentTurnObservation) => unknown;
};

export type ManagedAcpAttemptInput = {
  runId: string;
  attemptId: string;
  sessionName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  agent: AgentSelector;
  permissionMode: AgentPermissionMode;
  model?: string;
  inactivityFailAfterMs?: number;
  onAcpActivity?: (observedAt: string) => void;
};

export type ManagedAcpAttempt = {
  runTurn(input: AgentTurnRequest): Promise<AgentTurnResult>;
};

export type ManagedAcpExecutor = {
  withAttempt<T>(input: ManagedAcpAttemptInput, use: (attempt: ManagedAcpAttempt) => Promise<T>): Promise<T>;
  shutdown(): Promise<void>;
};

export type AcpOwnershipManifest = {
  schemaVersion: 1;
  workerId: string;
  runId: string;
  attemptId: string;
  sessionName: string;
  daemon: {
    pid: number;
    startToken?: string;
    generation: string;
  };
  worker: {
    pid: number;
    startToken?: string;
    pgid?: number;
  };
  state: "active" | "degraded";
  createdAt: string;
  cleanup?: {
    attemptedAt: string;
    reason: string;
  };
};

export type AcpOwnershipHealth = {
  degraded: number;
  orphaned: number;
  manifests: Array<Pick<AcpOwnershipManifest, "workerId" | "runId" | "attemptId" | "state">>;
};
