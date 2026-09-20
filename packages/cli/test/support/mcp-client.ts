import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import { expect } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";

export function withMcpClient<A>(use: (client: Client) => Promise<A>, mode: "legacy" | "auto" = "legacy"): Promise<A> {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntimePromise();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    yield* Effect.acquireRelease(Effect.sync(() => serveStdio(
      () => createMcpServer((operation, signal) => run(operation, { signal })),
      { transport: serverTransport },
    )), server => Effect.promise(() => server.close()));
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new Client({ name: "acpus-test", version: "1" }, { versionNegotiation: { mode } })),
      client => Effect.promise(() => client.close()),
    );
    yield* Effect.promise(() => client.connect(clientTransport));
    return yield* Effect.promise(() => use(client));
  })));
}

export function toolData(result: CallToolResult): Record<string, any> {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
  return result.structuredContent!;
}
