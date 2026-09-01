import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { inspectAgentTeam } from "./inspection.js";

type AgentTeamWebPhase = "starting" | "running" | "settled";

export type AgentTeamWebState = {
  phase: AgentTeamWebPhase;
  statePath: string;
  teamId?: string;
};

export type AgentTeamWebServerHandle = Readonly<{
  url: string;
}>;

export class AgentTeamWebServerFailure extends Error {
  readonly type = "agent_team_web_server_failure";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentTeamWebServerFailure";
  }
}

type WebAssets = Readonly<{
  html: string;
  script: string;
  stylesheet: string;
}>;

const securityHeaders = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export function startAgentTeamWebServer(
  state: AgentTeamWebState,
): Effect.Effect<AgentTeamWebServerHandle, AgentTeamWebServerFailure, Scope.Scope> {
  return Effect.try({
    try: loadAssets,
    catch: cause => new AgentTeamWebServerFailure("Could not load the Agent Team Web assets.", { cause }),
  }).pipe(
    Effect.flatMap(assets => Effect.acquireRelease(
      Effect.sync(() => createServer((request, response) => {
        void handleRequest(request.method, request.url, response, state, assets);
      })),
      server => closeServer(server).pipe(Effect.orDie),
    )),
    Effect.tap(server => listen(server)),
    Effect.map(server => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new AgentTeamWebServerFailure("The Agent Team Web server did not expose a TCP address.");
      }
      return { url: `http://127.0.0.1:${address.port}/` };
    }),
  );
}

async function handleRequest(
  method: string | undefined,
  rawUrl: string | undefined,
  response: ServerResponse,
  state: AgentTeamWebState,
  assets: WebAssets,
): Promise<void> {
  try {
    const path = new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
    if (method !== "GET") {
      sendJson(response, 405, { ok: false, error: { code: "method_not_allowed", message: "Method not allowed." } });
      return;
    }
    if (path === "/") {
      send(response, 200, "text/html; charset=utf-8", assets.html);
      return;
    }
    if (path === "/app.js") {
      send(response, 200, "text/javascript; charset=utf-8", assets.script);
      return;
    }
    if (path === "/styles.css") {
      send(response, 200, "text/css; charset=utf-8", assets.stylesheet);
      return;
    }
    if (path === "/api/team") {
      if (state.teamId === undefined) {
        sendJson(response, 200, { ok: true, phase: state.phase });
        return;
      }
      try {
        const inspection = await Effect.runPromise(inspectAgentTeam({
          statePath: state.statePath,
          teamId: state.teamId,
          limit: 1_000,
        }));
        sendJson(response, 200, { ok: true, phase: state.phase, inspection });
      } catch {
        sendJson(response, 503, {
          ok: false,
          error: {
            code: "inspection_unavailable",
            message: "The Agent Team inspection is temporarily unavailable.",
          },
        });
      }
      return;
    }
    sendJson(response, 404, { ok: false, error: { code: "not_found", message: "Route not found." } });
  } catch {
    sendJson(response, 500, { ok: false, error: { code: "internal_error", message: "Internal server error." } });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  });
  response.end(body);
}

function listen(server: Server): Effect.Effect<void, AgentTeamWebServerFailure> {
  return Effect.callback<void, AgentTeamWebServerFailure>(resume => {
    const onError = (cause: unknown) => resume(Effect.fail(new AgentTeamWebServerFailure(
      "Could not start the Agent Team Web server on 127.0.0.1.",
      { cause },
    )));
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
    return Effect.sync(() => server.off("error", onError));
  });
}

function closeServer(server: Server): Effect.Effect<void, unknown> {
  return Effect.callback<void, unknown>(resume => {
    server.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") resume(Effect.fail(error));
      else resume(Effect.void);
    });
  });
}

function loadAssets(): WebAssets {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
  return {
    html: readFileSync(join(root, "index.html"), "utf8"),
    script: readFileSync(join(root, "app.js"), "utf8"),
    stylesheet: readFileSync(join(root, "styles.css"), "utf8"),
  };
}
