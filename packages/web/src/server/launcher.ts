import { serve } from "@hono/node-server";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebApp } from "./app.js";
import { mountStaticAssets } from "./assets.js";
import { createAccessPolicy } from "./security.js";
import type { EnsureRuntimeAuthority } from "./runtime-authority.js";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

export type WebServerOptions = {
  cwd: string;
  host?: string;
  port?: number;
  token?: boolean;
  ensureDaemonRunning: EnsureRuntimeAuthority;
};

export type WebServerHandle = {
  url: string;
  token?: string;
};

export type WebServerStartFailure = {
  type: "listen-failed";
  host: string;
  port: number;
  message: string;
};

export function startWebServer(options: WebServerOptions): Effect.Effect<WebServerHandle, WebServerStartFailure, Scope.Scope> {
  const host = options.host ?? "localhost";
  const requestedPort = options.port ?? 0;
  const access = createAccessPolicy({ enabled: options.token === true });
  const app = createWebApp({
    cwd: options.cwd,
    access,
    ensureDaemonRunning: options.ensureDaemonRunning,
  });
  mountStaticAssets(app, defaultStaticDir());

  return Effect.acquireRelease(
    Effect.callback<ReturnType<typeof serve>, WebServerStartFailure>(resume => {
      let server!: ReturnType<typeof serve>;
      const onError = (cause: unknown) => resume(Effect.fail({
        type: "listen-failed" as const,
        host,
        port: requestedPort,
        message: cause instanceof Error && cause.message.length > 0 ? cause.message : `Failed to listen on ${host}:${requestedPort}.`,
      }));
      try {
        server = serve(
          { fetch: app.fetch, hostname: host, port: requestedPort },
          () => {
            server.off("error", onError);
            resume(Effect.succeed(server));
          },
        );
      } catch (cause) {
        onError(cause);
        return;
      }
      server.once("error", onError);
      return Effect.sync(() => server.off("error", onError)).pipe(
        Effect.andThen(closeServer(server)),
        Effect.ignore,
      );
    }),
    server => closeServer(server).pipe(Effect.orDie),
  ).pipe(Effect.map(server => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : requestedPort;

    return {
      url: `http://${host}:${port}${access.token === undefined ? "" : `/?token=${encodeURIComponent(access.token)}`}`,
      ...(access.token === undefined ? {} : { token: access.token }),
    };
  }));
}

function closeServer(server: ReturnType<typeof serve>): Effect.Effect<void, unknown> {
  return Effect.callback<void, unknown>(resume => {
    server.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") resume(Effect.fail(error));
      else resume(Effect.void);
    });
  });
}

function defaultStaticDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "client");
}
