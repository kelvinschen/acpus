import type { Writable } from "node:stream";
import { Command } from "commander";
import { ensureDaemonRunning } from "../daemon/client.js";
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

      const started = await startWebServer({
        cwd: ctx.cwd,
        host,
        ...(port !== undefined ? { port } : {}),
        ...(options.token ? { token: true } : {}),
        ensureDaemonRunning: async cwd => {
          const ready = await ensureDaemonRunning(cwd);
          if (ready.isErr()) throw usageError(ready.error.message);
        },
      });
      if (started.isErr()) throw runError(started.error.message, { errorCode: "LISTEN_FAILED" });
      const server = started.value;

      ctx.stderr.write(`Acpus WebUI starting at ${server.url}\n`);
      if (server.token) {
        ctx.stderr.write(`Access token: ${server.token}\n`);
      }
      ctx.stderr.write("Press Ctrl+C to stop.\n");

      await waitForShutdownSignal(server);
    });
}

async function waitForShutdownSignal(server: { close(): Promise<void> }): Promise<void> {
  let closing: Promise<void> | undefined;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    };
    const shutdown = () => {
      if (closing) return;
      closing = server.close();
      void closing.then(() => {
        cleanup();
        resolve();
      }, error => {
        cleanup();
        reject(error);
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
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
