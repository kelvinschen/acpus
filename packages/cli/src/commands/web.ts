import type { Writable } from "node:stream";
import { Command } from "commander";
import { usageError } from "../errors.js";
import { ensureDaemonRunning } from "./daemon.js";

export type WebCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  startWebServer?: WebServerStarter;
  waitForSignals?: boolean;
};

type WebServerStarter = (options: {
  cwd: string;
  host?: string;
  port?: number;
  token?: boolean;
  ensureDaemonRunning?: (cwd: string) => void;
}) => Promise<{
  url: string;
  token?: string;
  close(): Promise<void>;
}>;

export function createWebCommand(ctx: WebCommandContext): Command {
  return new Command("web")
    .exitOverride()
    .description("Start the local web operator console.")
    .option("--host <host>", "bind host (default: localhost)")
    .option("--port <port>", "bind port (default: random)")
    .option("--token", "protect the WebUI with a generated access token")
    .action(async (options: { host?: string; port?: string; token?: boolean }) => {
      const host = options.host ?? "localhost";
      const port = parsePort(options.port);
      const startWebServer = ctx.startWebServer ?? (await import("@acpus/web")).startWebServer;

      const server = await startWebServer({
        cwd: ctx.cwd,
        host,
        ...(port !== undefined ? { port } : {}),
        ...(options.token ? { token: true } : {}),
        ensureDaemonRunning,
      });

      if (ctx.wantsJson) {
        ctx.stdout.write(JSON.stringify({ url: server.url, ...(server.token ? { token: server.token } : {}) }) + "\n");
      } else {
        ctx.stderr.write(`Acpus WebUI starting at ${server.url}\n`);
        if (server.token) {
          ctx.stderr.write(`Access token: ${server.token}\n`);
        }
        ctx.stderr.write("Press Ctrl+C to stop.\n");
      }

      if (ctx.waitForSignals === false) return;

      await new Promise<void>(() => {
        process.on("SIGINT", async () => {
          await server.close();
          process.exit(0);
        });
        process.on("SIGTERM", async () => {
          await server.close();
          process.exit(0);
        });
      });
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
