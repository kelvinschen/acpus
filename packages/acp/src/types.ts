import type { ResultAsync } from "neverthrow";

export type AcpJsonValue =
  | null
  | boolean
  | number
  | string
  | AcpJsonValue[]
  | { [key: string]: AcpJsonValue };

export type AcpPermissionMode = "approve-reads" | "approve-all" | "deny-all";

export type AcpLaunch =
  | Readonly<{ kind: "command"; command: string; name?: string }>
  | Readonly<{ kind: "argv"; argv: readonly [string, ...string[]]; name?: string }>;

export type AcpSessionConfiguration = Readonly<{
  model?: string;
  options?: Readonly<Record<string, string>>;
}>;

export type AgentSessionBindingCategory = "launch" | "cwd" | "model" | "options";

export type OpenAcpSessionInput = Readonly<{
  agentSessionId: string;
  sessionOpenMode: "new_or_empty" | "existing_required";
  stateDirectory: string;
  launch: AcpLaunch;
  cwd: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  permissionMode: AcpPermissionMode;
  configuration: Readonly<{ model: string | null; options: Readonly<Record<string, string>> }>;
  signal?: AbortSignal;
}>;

export type AcpTokenUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}>;

export type AcpContextUsage = Readonly<{ used: number; size: number }>;
export type AcpCost = Readonly<{ amount: number; currency: string }>;

export type AcpClientOperation =
  | "session/request_permission"
  | "fs/read_text_file"
  | "fs/write_text_file"
  | "terminal/create"
  | "terminal/output"
  | "terminal/wait_for_exit"
  | "terminal/kill"
  | "terminal/release";

export type AcpEvent =
  | Readonly<{
      type: "message";
      channel: "assistant" | "thought";
      content: AcpJsonValue;
      messageId?: string;
    }>
  | Readonly<{
      type: "tool";
      action: "call" | "update";
      toolCallId: string;
      title?: string;
      name?: string;
      kind?: string;
      status?: string;
      input?: AcpJsonValue;
      output?: AcpJsonValue;
      content?: AcpJsonValue;
      locations?: AcpJsonValue;
    }>
  | Readonly<{
      type: "usage";
      context?: AcpContextUsage;
      tokens?: AcpTokenUsage;
      cost?: AcpCost;
    }>
  | Readonly<{ type: "plan"; value: AcpJsonValue }>
  | Readonly<{
      type: "session";
      update: "available_commands" | "current_mode" | "configuration" | "info";
      value: AcpJsonValue;
    }>
  | Readonly<{ type: "activity"; operation: AcpClientOperation }>
  | Readonly<{ type: "unknown"; name: string; value: AcpJsonValue }>;

export type AcpOperation =
  | "open_session"
  | "initialize"
  | "new_session"
  | "resume_session"
  | "load_session"
  | "configure_session"
  | "run_turn"
  | "cancel_turn"
  | "close_session"
  | AcpClientOperation;

type AcpErrorBase = Readonly<{
  operation: AcpOperation;
  origin: "input" | "persistence" | "client" | "provider" | "transport" | "process";
  providerEvidence: "none" | "inbound_activity" | "terminal_response";
  message: string;
  retryable: boolean;
  code?: string | number;
}>;

export type AcpError =
  | (AcpErrorBase & Readonly<{ type: "invalid_input" }>)
  | (AcpErrorBase & Readonly<{ type: "persistence"; path: string }>)
  | (AcpErrorBase & Readonly<{ type: "spawn" }>)
  | (AcpErrorBase & Readonly<{ type: "cancelled" }>)
  | (AcpErrorBase & Readonly<{ type: "cleanup" }>)
  | (AcpErrorBase & Readonly<{ type: "initialize" }>)
  | (AcpErrorBase & Readonly<{ type: "protocol" }>)
  | (AcpErrorBase & Readonly<{ type: "capability"; capability: "resume" | "load" | "configuration" }>)
  | (AcpErrorBase & Readonly<{ type: "session" }>)
  | (AcpErrorBase & Readonly<{ type: "configuration" }>)
  | (AcpErrorBase & Readonly<{ type: "provider_exit"; exitCode: number | null; signal: string | null }>)
  | (AcpErrorBase & Readonly<{ type: "client_operation" }>)
  | AcpSessionBindingError;

export type AcpSessionBindingError = Omit<
  AcpErrorBase,
  "operation" | "origin" | "providerEvidence" | "retryable"
> & Readonly<{
  type: "session_binding";
  operation: "open_session";
  origin: "persistence";
  providerEvidence: "none";
  retryable: false;
  categories: readonly [AgentSessionBindingCategory, ...AgentSessionBindingCategory[]];
}>;

export type AcpTurnInput = Readonly<{
  prompt: string;
  configuration?: AcpSessionConfiguration;
  signal?: AbortSignal;
  onEvent?: (event: AcpEvent) => unknown;
}>;

export type AcpTurnResult = Readonly<{
  status: "completed" | "cancelled";
  stopReason: string;
  usage?: AcpTokenUsage;
}>;

export interface AcpSession {
  readonly agentSessionId: string;
  readonly sessionId: string;
  readonly projectionPath: string;
  readonly reportedVersion?: string;
  runTurn(input: AcpTurnInput): ResultAsync<AcpTurnResult, AcpError>;
  close(reason?: string): ResultAsync<void, AcpError>;
}
