import type { McpServer } from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { registerTools, type AcpusMcpOptions } from "./tools.js";

export { acpusInstructions, type AcpusMcpOptions, type AcpusToolHandler } from "./tools.js";

/** Register ACPUS in a host-owned server. Each call follows the SDK request signal. */
export function registerAcpusTools(server: McpServer, options: AcpusMcpOptions = {}) {
  return registerTools(server, (operation, signal) => Effect.runPromise(
    operation.pipe(Effect.provideService(Logger.LogToStderr, true)),
    { signal },
  ), options);
}
