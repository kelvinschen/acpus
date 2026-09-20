import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerAcpusTools } from "acpus/mcp";
import { resolveAcpusHome } from "@acpus/runtime";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vitest";
import { withPlainTestWorkspace } from "./support/workspace.js";

const inspection = vi.hoisted(() => ({ inspectRun: vi.fn() }));
vi.mock("../src/mcp/inspection.js", () => inspection);

it("disconnect interrupts embedded calls, completes finalization, and keeps logs off stdout", async () => {
  await withPlainTestWorkspace("mcp-adapter-close", async (workspace, home) => {
    vi.stubEnv("ACPUS_HOME", home);
    let enter!: () => void;
    let settle!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const settled = new Promise<void>(resolve => { settle = resolve; });
    let releasedHome: string | undefined;
    inspection.inspectRun.mockReturnValue(Effect.sync(enter).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.logInfo("adapter-finalized").pipe(Effect.andThen(Effect.sync(() => { releasedHome = resolveAcpusHome(); })))),
    ));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new McpServer({ name: "embedded-acpus", version: "1" });
    registerAcpusTools(server, {
      wrapTool: (_name, handler) => async (args, context) => {
        try { return await handler(args, context); }
        finally { settle(); }
      },
    });
    const client = new Client({ name: "host", version: "1" }, { versionNegotiation: { mode: "legacy" } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const pending = client.callTool({ name: "acpus_inspect", arguments: { workspace, runId: "run-1", wait: "terminal" } }).catch(() => undefined);
      await entered;
      vi.stubEnv("ACPUS_HOME", `${home}/another-instance`);
      await client.close();
      await settled;
      await pending;
      expect(releasedHome).toBe(home);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls.flat()).toContain("adapter-finalized");
    } finally {
      await client.close();
      await server.close();
      stdout.mockRestore();
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
