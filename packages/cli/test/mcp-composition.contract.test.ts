import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { acpusInstructions, registerAcpusTools } from "acpus/mcp";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { toolData } from "./support/mcp-client.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

afterEach(() => vi.unstubAllEnvs());

async function withHostClient(server: McpServer, use: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => server, { transport: serverTransport });
  const client = new Client({ name: "custom-host-client", version: "1" }, { versionNegotiation: { mode: "legacy" } });
  try {
    await client.connect(clientTransport);
    await use(client);
  } finally {
    await client.close();
    await handle.close();
  }
}

it("composes ACPUS with host Instructions, tools, and SDK metadata updates", async () => {
  await withPlainTestWorkspace("mcp-composition", async (workspace, home) => {
    vi.stubEnv("ACPUS_HOME", home);
    const instructions = `${acpusInstructions}\nAssociate runs with the current host conversation.`;
    const server = new McpServer({ name: "custom-acpus-host", version: "1" }, { instructions });
    const tools = registerAcpusTools(server);
    tools.acpus_list_runs.update({ description: "List this host's runs.", _meta: { hostPanel: "runs" } });
    server.registerTool("host_context", { inputSchema: z.object({}) }, async () => ({
      content: [{ type: "text", text: "conversation-1" }],
    }));

    await withHostClient(server, async client => {
      expect(client.getInstructions()).toBe(instructions);
      const advertised = (await client.listTools()).tools;
      expect(advertised.find(tool => tool.name === "acpus_list_runs")).toMatchObject({
        description: "List this host's runs.", _meta: { hostPanel: "runs" },
      });
      expect((await client.callTool({ name: "host_context", arguments: {} })).content).toEqual([
        { type: "text", text: "conversation-1" },
      ]);
      expect(toolData(await client.callTool({ name: "acpus_list_runs", arguments: { workspace } }))).toEqual({ workspace, runs: [] });
    });
  });
});

it("lets a host wrap parsed tool arguments, SDK context, and structured results", async () => {
  await withPlainTestWorkspace("mcp-tool-wrapper", async (workspace, home) => {
    vi.stubEnv("ACPUS_HOME", home);
    const server = new McpServer({ name: "custom-acpus-host", version: "1" });
    const calls: Array<{ name: string; args: Record<string, unknown>; context: ServerContext; data: unknown }> = [];
    registerAcpusTools(server, {
      wrapTool: (name, handler) => async (args, context) => {
        const result = await handler(args, context);
        calls.push({ name, args, context, data: result.structuredContent });
        return { ...result, _meta: { ...result._meta, hostConversation: "conversation-1" } };
      },
    });

    await withHostClient(server, async client => {
      const result = await client.callTool({
        name: "acpus_list_runs", arguments: { workspace }, _meta: { hostRequest: "request-1" },
      });
      expect(toolData(result)).toEqual({ workspace, runs: [] });
      expect(result._meta).toEqual({ hostConversation: "conversation-1" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        name: "acpus_list_runs", args: { workspace, offset: 0, limit: 50 }, data: { workspace, runs: [] },
        context: { mcpReq: { method: "tools/call", _meta: { hostRequest: "request-1" } } },
      });
      expect(calls[0]!.context.mcpReq.signal).toBeInstanceOf(AbortSignal);
    });
  });
});

it("validates before entering wrappers and preserves business failures through them", async () => {
  await withPlainTestWorkspace("mcp-wrapper-errors", async (workspace, home) => {
    vi.stubEnv("ACPUS_HOME", home);
    const server = new McpServer({ name: "custom-acpus-host", version: "1" });
    const wrapped = vi.fn<(result: CallToolResult) => void>();
    registerAcpusTools(server, {
      wrapTool: (_name, handler) => async (args, context) => {
        const result = await handler(args, context);
        wrapped(result);
        return result;
      },
    });

    await withHostClient(server, async client => {
      const invalid = await client.callTool({ name: "acpus_list_runs", arguments: { workspace: "." } });
      expect(invalid.isError).toBe(true);
      expect(wrapped).not.toHaveBeenCalled();

      const failed = await client.callTool({ name: "acpus_inspect", arguments: { workspace, runId: "missing" } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({
        error: { code: "RUNTIME_STORE_NOT_FOUND", workspace, runId: "missing", next: expect.any(String) },
      });
      expect(wrapped).toHaveBeenCalledExactlyOnceWith(failed);
      expect(failed.content).toEqual([{ type: "text", text: JSON.stringify(failed.structuredContent) }]);
    });
  });
});
