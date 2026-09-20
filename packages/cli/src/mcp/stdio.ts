import type { McpIo } from "./command.js";
import * as Effect from "effect/Effect";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as Deferred from "effect/Deferred";
import * as FiberSet from "effect/FiberSet";
import * as Logger from "effect/Logger";
import { createMcpServer } from "./server.js";

export function serveMcp(io: McpIo): Effect.Effect<void> {
  return Effect.scoped(Effect.gen(function* () {
    const stopped = yield* Deferred.make<void>();
    const stop = () => { Deferred.doneUnsafe(stopped, Effect.void); };
    const run = yield* FiberSet.makeRuntimePromise();
    yield* Effect.acquireRelease(Effect.sync(() => {
      io.stdin.on("end", stop);
      io.stdin.on("close", stop);
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return stop;
    }), stop => Effect.sync(() => {
      io.stdin.off("end", stop);
      io.stdin.off("close", stop);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }));
    yield* Effect.acquireRelease(Effect.sync(() => {
      const transport = new StdioServerTransport(io.stdin, io.stdout);
      const handle = serveStdio(() => createMcpServer((effect, signal) => run(effect, { signal })), {
        transport,
        onerror: error => { io.stderr.write(`${error.message}\n`); },
      });
      const onclose = transport.onclose;
      transport.onclose = () => { onclose?.(); stop(); };
      return handle;
    }), handle => Effect.promise(() => handle.close()));
    if (!io.stdin.readableEnded && !io.stdin.destroyed) yield* Deferred.await(stopped);
  })).pipe(Effect.provide(Logger.layer([
    Logger.make(options => { io.stderr.write(`${Logger.formatSimple.log(options)}\n`); }),
  ])));
}
