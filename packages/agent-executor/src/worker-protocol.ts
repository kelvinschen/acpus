import type { AcpError, AcpEvent, AcpTurnResult, AgentSessionBindingFingerprintV1 } from "@acpus/acp";
import type { AcpAgentLaunch, AgentPermissionMode, ProcessCapsuleError } from "./types.js";

export const ACP_WORKER_PROTOCOL_VERSION = 9;

type CapsuleIdentity = Readonly<{ hostId: string; sessionLeaseId: string }>;

type ProcessCapsuleOpenInput = CapsuleIdentity & Readonly<{
  runId: string;
  attemptId: string;
  agentSessionId: string;
  sessionOpenMode: "new_or_empty" | "existing_required";
  sessionStateDirectory: string;
  resolvedLaunch: AcpAgentLaunch;
  cwd: string;
  env: Readonly<Record<string, string>>;
  permissionMode: AgentPermissionMode;
  configuration: Readonly<{ model?: string; options: Readonly<Record<string, string>> }>;
  bindingFingerprint: AgentSessionBindingFingerprintV1;
}>;

export type AcpWorkerParentMessage =
  | Readonly<{
      type: "open";
      protocolVersion: 9;
      input: ProcessCapsuleOpenInput;
    }>
  | (CapsuleIdentity & Readonly<{ type: "run"; protocolVersion: 9; turnId: string; prompt: string }>)
  | (CapsuleIdentity & Readonly<{
      type: "cancel";
      protocolVersion: 9;
      turnId: string;
      reason: "operator" | "pause" | "lease_lost" | "steer" | "event_sink" | "deadline" | "inactivity";
    }>)
  | (CapsuleIdentity & Readonly<{
      type: "close";
      protocolVersion: 9;
      reason: "lease_settled" | "open_failed" | "neutralize" | "shutdown";
    }>);

export type ProcessCapsuleTerminal =
  | Readonly<{ type: "provider_result"; result: AcpTurnResult }>
  | Readonly<{ type: "provider_error_response"; error: AcpError }>
  | Readonly<{ type: "local_error"; error: AcpError }>;

export type AcpWorkerChildMessage =
  | (CapsuleIdentity & Readonly<{
      type: "ready";
      protocolVersion: 9;
      projectionRef: string;
      bindingFingerprint: AgentSessionBindingFingerprintV1;
      reportedVersion?: string;
    }>)
  | (CapsuleIdentity & Readonly<{ type: "event"; protocolVersion: 9; turnId: string; event: AcpEvent }>)
  | (CapsuleIdentity & Readonly<{ type: "terminal"; protocolVersion: 9; turnId: string; terminal: ProcessCapsuleTerminal }>)
  | (CapsuleIdentity & Readonly<{ type: "open_failed"; protocolVersion: 9; error: AcpError }>)
  | (CapsuleIdentity & Readonly<{ type: "failed"; protocolVersion: 9; error: ProcessCapsuleError }>)
  | (CapsuleIdentity & Readonly<{ type: "closed"; protocolVersion: 9 }>);

export function isAcpWorkerParentMessage(value: unknown): value is AcpWorkerParentMessage {
  if (!record(value) || value.protocolVersion !== ACP_WORKER_PROTOCOL_VERSION) return false;
  if (value.type === "open") {
    return exactKeys(value, ["type", "protocolVersion", "input"])
      && openInput(value.input);
  }
  if (!identity(value)) return false;
  if (value.type === "run") {
    return exactKeys(value, ["type", "protocolVersion", "hostId", "sessionLeaseId", "turnId", "prompt"])
      && string(value.turnId) && typeof value.prompt === "string";
  }
  if (value.type === "cancel") {
    return exactKeys(value, ["type", "protocolVersion", "hostId", "sessionLeaseId", "turnId", "reason"])
      && string(value.turnId)
      && ["operator", "pause", "lease_lost", "steer", "event_sink", "deadline", "inactivity"].includes(String(value.reason));
  }
  return value.type === "close"
    && exactKeys(value, ["type", "protocolVersion", "hostId", "sessionLeaseId", "reason"])
    && ["lease_settled", "open_failed", "neutralize", "shutdown"].includes(String(value.reason));
}

export function isAcpWorkerChildMessage(value: unknown): value is AcpWorkerChildMessage {
  if (!record(value) || value.protocolVersion !== ACP_WORKER_PROTOCOL_VERSION || !identity(value)) return false;
  if (value.type === "ready") {
    return exactKeys(
      value,
      ["type", "protocolVersion", "hostId", "sessionLeaseId", "projectionRef", "bindingFingerprint"],
      ["reportedVersion"],
    )
      && string(value.projectionRef)
      && bindingFingerprint(value.bindingFingerprint)
      && (value.reportedVersion === undefined || boundedString(value.reportedVersion, 256));
  }
  if (value.type === "event") {
    return exactKeys(value, ["type", "protocolVersion", "hostId", "sessionLeaseId", "turnId", "event"])
      && string(value.turnId) && acpEvent(value.event);
  }
  if (value.type === "terminal") {
    return exactKeys(value, ["type", "protocolVersion", "hostId", "sessionLeaseId", "turnId", "terminal"])
      && string(value.turnId) && terminal(value.terminal);
  }
  if (value.type === "open_failed") {
    return exactKeys(value, ["type", "protocolVersion", "hostId", "sessionLeaseId", "error"]) && acpError(value.error);
  }
  if (value.type === "failed") {
    return exactKeys(value, ["type", "protocolVersion", "hostId", "sessionLeaseId", "error"])
      && capsuleError(value.error);
  }
  return value.type === "closed" && exactKeys(value, ["type", "protocolVersion", "hostId", "sessionLeaseId"]);
}

function terminal(value: unknown): value is ProcessCapsuleTerminal {
  if (!record(value)) return false;
  if (value.type === "provider_result") return exactKeys(value, ["type", "result"]) && turnResult(value.result);
  if (value.type === "provider_error_response" || value.type === "local_error") {
    return exactKeys(value, ["type", "error"]) && acpError(value.error);
  }
  return false;
}

function turnResult(value: unknown): value is AcpTurnResult {
  return record(value)
    && exactKeys(value, ["status", "stopReason"], ["usage"])
    && (value.status === "completed" || value.status === "cancelled")
    && string(value.stopReason)
    && (value.usage === undefined || tokenUsage(value.usage));
}

function tokenUsage(value: unknown): boolean {
  return record(value)
    && exactKeys(value, [], ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"])
    && Object.values(value).every(item => finite(item));
}

function acpEvent(value: unknown): value is AcpEvent {
  if (!record(value) || !string(value.type)) return false;
  if (value.type === "message") {
    return exactKeys(value, ["type", "channel", "content"], ["messageId"])
      && (value.channel === "assistant" || value.channel === "thought") && json(value.content) && optionalString(value.messageId);
  }
  if (value.type === "tool") {
    return exactKeys(value, ["type", "action", "toolCallId"], ["title", "name", "kind", "status", "input", "output", "content", "locations"])
      && (value.action === "call" || value.action === "update") && string(value.toolCallId)
      && [value.title, value.name, value.kind, value.status].every(optionalString)
      && [value.input, value.output, value.content, value.locations].every(optionalJson);
  }
  if (value.type === "usage") {
    return exactKeys(value, ["type"], ["context", "tokens", "cost"])
      && optionalJson(value.context) && optionalJson(value.tokens) && optionalJson(value.cost);
  }
  if (value.type === "plan") return exactKeys(value, ["type", "value"]) && json(value.value);
  if (value.type === "session") {
    return exactKeys(value, ["type", "update", "value"])
      && ["available_commands", "current_mode", "configuration", "info"].includes(String(value.update)) && json(value.value);
  }
  if (value.type === "activity") {
    return exactKeys(value, ["type", "operation"])
      && ["session/request_permission", "fs/read_text_file", "fs/write_text_file", "terminal/create", "terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release"].includes(String(value.operation));
  }
  return value.type === "unknown" && exactKeys(value, ["type", "name", "value"]) && string(value.name) && json(value.value);
}

function acpError(value: unknown): value is AcpError {
  if (!record(value) || !string(value.type) || !string(value.operation) || !string(value.message)
    || !acpOperation(value.operation)
    || !["input", "persistence", "client", "provider", "transport", "process"].includes(String(value.origin))
    || !["none", "inbound_activity", "terminal_response"].includes(String(value.providerEvidence))
    || typeof value.retryable !== "boolean" || (value.code !== undefined && typeof value.code !== "string" && !finite(value.code))) return false;
  const common = ["type", "operation", "origin", "providerEvidence", "message", "retryable"];
  const optional = ["code"];
  if (["invalid_input", "spawn", "cancelled", "cleanup", "initialize", "protocol", "session", "configuration", "client_operation"].includes(value.type)) return exactKeys(value, common, optional);
  if (value.type === "persistence") return exactKeys(value, [...common, "path"], optional) && string(value.path);
  if (value.type === "capability") return exactKeys(value, [...common, "capability"], optional) && ["resume", "load", "configuration"].includes(String(value.capability));
  if (value.type === "session_binding") {
    const order = ["launch", "cwd", "model", "options"];
    if (value.operation !== "open_session"
      || value.origin !== "persistence"
      || value.providerEvidence !== "none"
      || value.retryable !== false
      || !exactKeys(value, [...common, "categories"], optional)
      || !Array.isArray(value.categories)
      || value.categories.length === 0) return false;
    const categories = value.categories;
    return categories.every(category => order.includes(String(category)))
      && categories.every((category, index) => index === 0
        || order.indexOf(String(categories[index - 1])) < order.indexOf(String(category)));
  }
  return value.type === "provider_exit" && exactKeys(value, [...common, "exitCode", "signal"], optional)
    && (value.exitCode === null || finite(value.exitCode)) && (value.signal === null || string(value.signal));
}

function capsuleError(value: unknown): value is ProcessCapsuleError {
  return record(value) && exactKeys(value, ["type", "phase", "code", "message"])
    && value.type === "process_capsule" && ["bootstrap", "opening", "ready", "running", "closing"].includes(String(value.phase))
    && ["worker_spawn_failed", "worker_exit", "ipc_closed", "ipc_protocol", "worker_exception"].includes(String(value.code)) && string(value.message);
}

function bindingFingerprint(value: unknown): value is AgentSessionBindingFingerprintV1 {
  return record(value) && exactKeys(value, ["version", "digest", "components"])
    && value.version === 1 && sha256(value.digest) && record(value.components)
    && exactKeys(value.components, ["launch", "cwd", "model", "options"])
    && Object.values(value.components).every(sha256);
}

function openInput(value: unknown): value is ProcessCapsuleOpenInput {
  return record(value)
    && exactKeys(value, [
      "hostId", "sessionLeaseId", "runId", "attemptId", "agentSessionId",
      "sessionOpenMode", "sessionStateDirectory", "resolvedLaunch", "cwd", "env",
      "permissionMode", "configuration", "bindingFingerprint",
    ])
    && identity(value)
    && string(value.runId)
    && string(value.attemptId)
    && string(value.agentSessionId)
    && (value.sessionOpenMode === "new_or_empty" || value.sessionOpenMode === "existing_required")
    && string(value.sessionStateDirectory)
    && launch(value.resolvedLaunch)
    && string(value.cwd)
    && stringRecord(value.env)
    && permission(value.permissionMode)
    && configuration(value.configuration)
    && bindingFingerprint(value.bindingFingerprint);
}

function acpOperation(value: unknown): boolean {
  return [
    "open_session", "initialize", "new_session", "resume_session", "load_session",
    "configure_session", "run_turn", "cancel_turn", "close_session",
    "session/request_permission", "fs/read_text_file", "fs/write_text_file",
    "terminal/create", "terminal/output", "terminal/wait_for_exit", "terminal/kill",
    "terminal/release",
  ].includes(String(value));
}

function sha256(value: unknown): boolean { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }

function identity(value: Record<string, unknown>): boolean { return string(value.hostId) && string(value.sessionLeaseId); }
function configuration(value: unknown): boolean { return record(value) && exactKeys(value, ["options"], ["model"]) && optionalString(value.model) && stringRecord(value.options); }
function launch(value: unknown): value is AcpAgentLaunch {
  if (!record(value)) return false;
  return value.kind === "command"
    ? exactKeys(value, ["kind", "command"], ["name"]) && string(value.command) && optionalString(value.name)
    : value.kind === "argv" && exactKeys(value, ["kind", "argv"], ["name"]) && Array.isArray(value.argv) && value.argv.length > 0 && value.argv.every(string) && optionalString(value.name);
}
function permission(value: unknown): value is AgentPermissionMode { return value === "approve-reads" || value === "approve-all" || value === "deny-all"; }
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean { const allowed = new Set([...required, ...optional]); return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key)); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function boundedString(value: unknown, maxLength: number): value is string { return string(value) && value.length <= maxLength; }
function optionalString(value: unknown): boolean { return value === undefined || typeof value === "string"; }
function stringRecord(value: unknown): value is Record<string, string> { return record(value) && Object.values(value).every(item => typeof item === "string"); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function optionalJson(value: unknown): boolean { return value === undefined || json(value); }
function json(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => json(item, ancestors))
    : Object.values(value).every(item => json(item, ancestors));
  ancestors.delete(value);
  return valid;
}
