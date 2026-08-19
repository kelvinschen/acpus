import type { AcpError, AcpOperation } from "@acpus/acp";
import type { AgentBackendFailure } from "./types.js";

type AgentAcpOperation = NonNullable<AgentBackendFailure["upstream"]>["operation"];

export function failureFromAcpError(error: AcpError): AgentBackendFailure {
  const operation = agentOperation(error.operation);
  const localConfiguration = error.type === "invalid_input" || error.type === "persistence";
  const configuration = localConfiguration
    || error.type === "configuration"
    || error.type === "capability" && operation === "configure_session";
  return {
    kind: configuration ? "config" : error.type === "spawn" ? "spawn" : "provider_exit",
    origin: localConfiguration ? "runtime" : "provider",
    retryable: error.retryable,
    message: error.message,
    upstream: {
      source: "acp",
      operation,
      ...(error.code === undefined ? {} : { code: error.code }),
      origin: error.type,
    },
  };
}

function agentOperation(operation: AcpOperation): AgentAcpOperation {
  if (operation === "configure_session") return operation;
  if (operation === "open_session"
    || operation === "initialize"
    || operation === "new_session"
    || operation === "resume_session"
    || operation === "load_session") return "open_session";
  return "run_turn";
}
