import type { Writable } from "node:stream";
import { Command } from "commander";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ensureRuntimeAuthority } from "../daemon/client.js";
import { runError, usageError } from "../presentation/errors.js";

export type WebCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
};

type WebOptions = { host?: string; port?: string; token?: boolean };

export function createWebCommand(ctx: WebCommandContext): Command {
  return new Command("web")
    .exitOverride()
    .description("Start the local web operator console.")
    .option("--host <host>", "bind host (default: localhost)")
    .option("--port <port>", "bind port (default: random)")
    .option("--token", "protect the WebUI with a generated access token")
    .action(async (options: WebOptions) => {
      const host = options.host ?? "localhost";
      const port = parsePort(options.port);
      const { startWebServer } = await import("@acpus/web");

      const started = await Effect.runPromise(Effect.result(Effect.scoped(Effect.gen(function* () {
        const server = yield* startWebServer({
          cwd: ctx.cwd,
          host,
          ...(port !== undefined ? { port } : {}),
          ...(options.token ? { token: true } : {}),
          ensureDaemonRunning: async cwd => {
            const ready = await Effect.runPromise(Effect.result(ensureRuntimeAuthority(cwd, "control")));
            return Result.isSuccess(ready)
              ? { ok: true as const }
              : {
                  ok: false as const,
                  code: ready.failure.type.replaceAll("-", "_").toUpperCase(),
                  message: ready.failure.message,
                };
          },
        });

        yield* Effect.sync(() => {
          ctx.stderr.write(`Acpus WebUI starting at ${server.url}\n`);
          if (server.token) ctx.stderr.write(`Access token: ${server.token}\n`);
          ctx.stderr.write("Press Ctrl+C to stop.\n");
        });
        yield* waitForShutdownSignal();
      }))));
      if (Result.isFailure(started)) throw runError(started.failure.message, { errorCode: "LISTEN_FAILED" });
    });
}

function waitForShutdownSignal(): Effect.Effect<void> {
  return Effect.callback<void>(resume => {
    const cleanup = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    };
    const shutdown = () => {
      cleanup();
      resume(Effect.void);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return Effect.sync(cleanup);
  });
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw usageError("--port must be an integer between 1 and 65535.");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw usageError("--port must be an integer between 1 and 65535.");
  }
  return port;
}
