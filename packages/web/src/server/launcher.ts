import { serve } from "@hono/node-server";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebApp } from "./app.js";
import { mountStaticAssets } from "./assets.js";
import { createAccessPolicy } from "./security.js";
import { ResultAsync } from "neverthrow";

export type WebServerOptions = {
  cwd: string;
  host?: string;
  port?: number;
  token?: boolean;
  ensureDaemonRunning(cwd: string): void | Promise<void>;
};

export type WebServerHandle = {
  url: string;
  token?: string;
  close(): Promise<void>;
};

export type WebServerStartFailure = {
  type: "listen-failed";
  host: string;
  port: number;
  message: string;
};

export function startWebServer(options: WebServerOptions): ResultAsync<WebServerHandle, WebServerStartFailure> {
  const host = options.host ?? "localhost";
  const requestedPort = options.port ?? 0;
  const access = createAccessPolicy({ enabled: options.token === true });
  const app = createWebApp({
    cwd: options.cwd,
    access,
    ensureDaemonRunning: options.ensureDaemonRunning,
  });
  mountStaticAssets(app, defaultStaticDir());

  return ResultAsync.fromPromise(new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    let running: ReturnType<typeof serve>;
    const onError = (error: unknown) => reject(error);
    running = serve(
      { fetch: app.fetch, hostname: host, port: requestedPort },
      () => {
        running.off("error", onError);
        resolve(running);
      },
    );
    running.once("error", onError);
  }), cause => ({
    type: "listen-failed" as const,
    host,
    port: requestedPort,
    message: cause instanceof Error && cause.message.length > 0 ? cause.message : `Failed to listen on ${host}:${requestedPort}.`,
  })).map(server => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : requestedPort;
    let closePromise: Promise<void> | undefined;

    return {
      url: `http://${host}:${port}${access.token === undefined ? "" : `/?token=${encodeURIComponent(access.token)}`}`,
      ...(access.token === undefined ? {} : { token: access.token }),
      close: () => closePromise ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
  });
}

function defaultStaticDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "client");
}
