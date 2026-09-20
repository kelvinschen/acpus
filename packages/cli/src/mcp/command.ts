import type { Readable, Writable } from "node:stream";
import { Command } from "commander";
import * as Effect from "effect/Effect";

export type McpIo = { stdin: Readable; stdout: Writable; stderr: Writable };

export function createMcpCommand(io: McpIo): Command {
  return new Command("mcp")
    .exitOverride()
    .description("Serve Acpus workflow tools over MCP stdio; Runs continue after disconnect.")
    .action(async () => {
      const { serveMcp } = await import("./stdio.js");
      await Effect.runPromise(serveMcp(io));
    });
}
