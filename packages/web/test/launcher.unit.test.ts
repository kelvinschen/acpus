import { it } from "@effect/vitest";
import { describe, expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";

import { startWebServer, type WebServerStartFailure } from "../src/index.js";
import { settle } from "./effect.js";

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  inspectRuntimeStore: () => Effect.succeed({ state: "ready" as const }),
}));

const daemonReady = async () => ({ ok: true as const });

describe("startWebServer access policy", () => {
  liveTest("does not generate a token for network hosts by default", async scope => {
    const server = await startedServer(scope, { cwd: process.cwd(), host: "0.0.0.0", ensureDaemonRunning: daemonReady });
    expect(server.token).toBeUndefined();
    expect(server.url).not.toContain("token=");
  });

  liveTest("generates a token only when requested", async scope => {
    const server = await startedServer(scope, { cwd: process.cwd(), token: true, ensureDaemonRunning: daemonReady });
    expect(server.token).toBeDefined();
    expect(server.url).toContain(`token=${encodeURIComponent(server.token!)}`);
  });

  liveTest("starts and serves read-only routes without touching the daemon", async scope => {
    const ensureDaemonRunning = vi.fn();
    const server = await startedServer(scope, { cwd: process.cwd(), ensureDaemonRunning });
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    const response = await fetch(`${server.url}/api/config`);
    expect(response.status).toBe(200);
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
  });

  liveTest("forwards asynchronous daemon readiness failures through the server error boundary", async scope => {
    const cause = new Error("daemon readiness failed");
    const ensureDaemonRunning = vi.fn(async () => {
      throw cause;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const server = await startedServer(scope, { cwd: process.cwd(), ensureDaemonRunning });
      const catalogResponse = await fetch(`${server.url}/api/workspaces`);
      const catalog = await catalogResponse.json() as {
        catalog: { currentWorkspaceKey: string };
      };
      const response = await fetch(`${server.url}/api/workspaces/${catalog.catalog.currentWorkspaceKey}/runs/run_1/controls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "pause" }),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: "internal_error", message: "Internal server error." },
      });
      expect(ensureDaemonRunning).toHaveBeenCalledWith(process.cwd());
      expect(logged).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledWith("Acpus WebUI request failed:", cause);
    } finally {
      logged.mockRestore();
    }
  });

  liveTest("returns a tagged failure when the requested port is occupied", async scope => {
    const first = await startedServer(scope, { cwd: process.cwd(), host: "127.0.0.1", ensureDaemonRunning: daemonReady });
    const port = Number(new URL(first.url).port);
    const second = await settle(Effect.scoped(startWebServer({ cwd: process.cwd(), host: "127.0.0.1", port, ensureDaemonRunning: daemonReady })));
    expect(Result.isFailure(second)).toBe(true);
    if (Result.isFailure(second)) {
      const failure: WebServerStartFailure = second.failure;
      expect(failure).toMatchObject({ type: "listen-failed", host: "127.0.0.1", port });
    }
  });

  liveTest("returns a tagged failure when listen throws synchronously", async () => {
    const result = await settle(Effect.scoped(startWebServer({
      cwd: process.cwd(),
      host: "127.0.0.1",
      port: -1,
      ensureDaemonRunning: daemonReady,
    })));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        type: "listen-failed",
        host: "127.0.0.1",
        port: -1,
      });
    }
  });
});

async function startedServer(scope: Scope.Scope, options: Parameters<typeof startWebServer>[0]) {
  const result = await settle(Scope.provide(scope)(startWebServer(options)));
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
}

function liveTest(name: string, test: (scope: Scope.Scope) => Promise<void>): void {
  it.live(name, () => Effect.gen(function*() {
    const scope = yield* Effect.scope;
    yield* Effect.promise(() => test(scope));
  }));
}
