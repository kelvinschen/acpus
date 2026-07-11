import { serve } from "@hono/node-server";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebApp } from "./app.js";
import { mountStaticAssets } from "./assets.js";
import { createAccessPolicy } from "./security.js";

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

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const host = options.host ?? "localhost";
  const access = createAccessPolicy({ enabled: options.token === true });
  const app = createWebApp({
    cwd: options.cwd,
    access,
    ensureDaemonRunning: options.ensureDaemonRunning,
  });
  mountStaticAssets(app, defaultStaticDir());

  const server = await new Promise<ReturnType<typeof serve>>(resolve => {
    const running = serve(
      { fetch: app.fetch, hostname: host, port: options.port ?? 0 },
      () => resolve(running),
    );
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  let closePromise: Promise<void> | undefined;

  return {
    url: `http://${host}:${port}${access.token === undefined ? "" : `/?token=${encodeURIComponent(access.token)}`}`,
    ...(access.token === undefined ? {} : { token: access.token }),
    close: () => closePromise ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function defaultStaticDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "client");
}
