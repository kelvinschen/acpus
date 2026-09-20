import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { runSourceCli, repoRoot } from "./support/cli-runner.js";
import { withDaemonTestWorkspace, withPlainTestWorkspace } from "./support/workspace.js";
import { toolData } from "./support/mcp-client.js";

const content = `import { defineWorkflow, z } from "acpus/core";
export default defineWorkflow({ name: "mcp-loop", inputSchema: z.null() }).build(({ step }) => {
  const approval = step("approve").signal({ outputSchema: z.object({ ok: z.boolean() }), prompt: "approve" });
  const report = step("report").task({
    input: approval.output,
    exec: async ({ input, artifact }) => ({
      ok: input.ok,
      text: await artifact.write("report.txt", "mcp-result"),
    }),
  });
  return report.output;
});`;

describe("MCP stdio", () => {
  it.concurrent("shares durable Runs with CLI across disconnect and completes a Signal/artifact workflow", async ({ expect }) => {
    await withDaemonTestWorkspace("mcp-e2e", async (workspace, home, registerDaemonHome) => {
      const acpusHome = join(home, "mcp-data");
      registerDaemonHome(acpusHome);
      const cliOptions = { env: { ACPUS_HOME: acpusHome } };
      const first = await connect(home);
      let runId: string;
      try {
        const admitted = toolData(await first.client.callTool({ name: "acpus_run", arguments: { workspace,
          source: content, input: null,
        } }));
        runId = admitted.runId;
        await expect.poll(async () => toolData(await first.client.callTool({
          name: "acpus_inspect", arguments: { workspace, runId },
        })).view.run.status, { interval: 25, timeout: 5_000 }).toBe("awaiting");
      } finally {
        await first.client.close();
      }
      const [inspection, connection] = await Promise.allSettled([
        runSourceCli(workspace, ["runs", "inspect", runId], cliOptions),
        connect(home),
      ]);
      if (connection.status === "rejected") throw connection.reason;
      const second = connection.value;
      try {
        if (inspection.status === "rejected") throw inspection.reason;
        expect(inspection.value.exitCode, inspection.value.stderr).toBe(0);
        expect(inspection.value.stdout).toContain("awaiting");
        const sent = toolData(await second.client.callTool({ name: "acpus_control", arguments: { workspace, runId, action: { type: "signal", target: "approve", payload: { ok: true } } } }));
        expect(sent.control.state).toBe("consumed");
        const completed = toolData(await second.client.callTool({ name: "acpus_inspect", arguments: { workspace, runId, wait: "terminal" } }));
        expect(completed.view.run.status).toBe("completed");
        expect(completed.view.output.ok).toBe(true);
        const listed = toolData(await second.client.callTool({ name: "acpus_artifact", arguments: { workspace, runId, action: { type: "list", target: "report" } } }));
        expect(listed.artifacts).toHaveLength(1);
        const reference = completed.view.output.text.uri as string;
        const id = reference.slice(reference.lastIndexOf("/") + 1);
        const read = toolData(await second.client.callTool({ name: "acpus_artifact", arguments: { workspace, runId, action: { type: "read", id } } }));
        expect(read.content).toBe("mcp-result");
        expect(read.truncated).toBe(false);
      } finally {
        await second.client.close();
      }
      expect([...first.errors, ...second.errors]).toEqual([]);
    });
  });

  it.concurrent("routes concurrent Runs across projects and isolates a second Home for the same project", async () => {
    await withDaemonTestWorkspace("mcp-project-a", async (workspaceA, homeA, registerHomeA) => {
      await withDaemonTestWorkspace("mcp-project-b", async (workspaceB, homeB, registerHomeB) => {
        registerHomeA(join(homeA, "mcp-data"));
        registerHomeB(join(homeA, "mcp-data"));
        for (const [home, scale] of [[homeA, "small"], [homeB, "large"]] as const) {
          await mkdir(join(home, "mcp-data"));
          await writeFile(join(home, "mcp-data/config.json"), JSON.stringify({ authoring: { agentScale: scale } }));
        }
        for (const [workspace, name] of [[workspaceA, "project-a"], [workspaceB, "project-b"]] as const) {
          await writeFile(join(workspace, "workflow.ts"), `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({ name: "${name}" }).build(() => ({ project: "${name}" }));`);
        }
        const connections = await Promise.allSettled([connect(homeA), connect(homeB)]);
        try {
          const [firstConnection, secondConnection] = connections;
          if (firstConnection.status === "rejected") throw firstConnection.reason;
          if (secondConnection.status === "rejected") throw secondConnection.reason;
          const first = firstConnection.value;
          const second = secondConnection.value;
          const admitted = await Promise.all([workspaceA, workspaceB].map(workspace =>
            first.client.callTool({ name: "acpus_run", arguments: { workspace, file: "workflow.ts" } }).then(toolData)));
          for (const [i, run] of admitted.entries()) {
            const completed = toolData(await first.client.callTool({ name: "acpus_inspect", arguments: { workspace: run.workspace, runId: run.runId, wait: "terminal" } }));
            expect(completed.view.output).toEqual({ project: i === 0 ? "project-a" : "project-b" });
            expect(run.workspace).toBe([workspaceA, workspaceB][i]);
            const listed = toolData(await first.client.callTool({ name: "acpus_list_runs", arguments: { workspace: run.workspace } }));
            expect(listed.runs.map((value: { id: string }) => value.id)).toEqual([run.runId]);
          }
          for (const [client, scale] of [[first.client, "small"], [second.client, "large"]] as const) {
            expect(toolData(await client.callTool({ name: "acpus_agent", arguments: { workspace: workspaceA } })).scale.value).toBe(scale);
          }
          expect(toolData(await second.client.callTool({ name: "acpus_list_runs", arguments: { workspace: workspaceA } })).runs).toEqual([]);
        } finally {
          await Promise.all(connections.map(connection => connection.status === "fulfilled" ? connection.value.client.close() : undefined));
        }
      });
    });
  });

  it.concurrent.each(["SIGINT", "SIGTERM"] as const)("closes the stdio connection on %s", async signal => {
    await withPlainTestWorkspace("mcp-stop", async (_workspace, home) => {
      const connection = await connect(home);
      try {
        const closed = new Promise<void>(resolve => { connection.client.onclose = resolve; });
        process.kill(connection.transport.pid!, signal);
        await closed;
        expect(connection.errors).toEqual([]);
      } finally {
        await connection.client.close();
      }
    });
  });
});

async function connect(home: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--conditions=development", "--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "mcp"],
    cwd: repoRoot,
    env: { ...getDefaultEnvironment(), ACPUS_HOME: join(home, "mcp-data"), HOME: home, USERPROFILE: home, NODE_ENV: "test" },
    stderr: "pipe",
  });
  const errors: string[] = [];
  const client = new Client({ name: "acpus-e2e", version: "1" });
  client.onerror = error => { errors.push(error.message); };
  try {
    await client.connect(transport);
    return { client, transport, errors };
  } catch (error) {
    await client.close();
    throw error;
  }
}
