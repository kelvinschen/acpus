import type { AgentBackendFailure } from "./types.js";

export type AcpRuntimeOperation = NonNullable<AgentBackendFailure["upstream"]>["operation"];

export function failureFromAcpRuntime(error: unknown, operation: AcpRuntimeOperation): AgentBackendFailure {
  return {
    kind: operation === "session.set_config_option" ? "config" : "provider_exit",
    origin: "provider",
    message: error instanceof Error ? error.message : String(error),
    upstream: { source: "acpx", operation },
  };
}
