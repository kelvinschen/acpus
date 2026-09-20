import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { tryPrepareWorkflow } from "@acpus/workflow-compiler";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPlainTestWorkspace } from "./support/workspace.js";
import { toolData, withMcpClient } from "./support/mcp-client.js";
import { preparedWorkflow } from "./support/prepared-workflow.js";

const compiler = vi.hoisted(() => ({ tryPrepareWorkflow: vi.fn<typeof tryPrepareWorkflow>() }));
vi.mock("@acpus/workflow-compiler", () => compiler);

beforeEach(() => {
  compiler.tryPrepareWorkflow.mockReset();
  compiler.tryPrepareWorkflow.mockReturnValue(Effect.succeed(preparedWorkflow({
    irVersion: 8,
    name: "mcp-validation",
    inputSchema: { kind: "null" },
    agents: { worker: { kind: "agent_slot" } },
    root: { nodes: [], output: { kind: "object", fields: {} } },
    diagnostics: [],
  })));
});

afterEach(() => vi.unstubAllEnvs());

describe("MCP tools", () => {
  it.each(["legacy", "auto"] as const)("discovers usable tools over the SDK %s connection without creating Runtime state", async mode => {
    await withPlainTestWorkspace("mcp-discovery", async (workspace, home) => {
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.stubEnv("ACPUS_AUTHORING_AGENT_SCALE", "small");
      await withMcpClient(async client => {
        const tools = (await client.listTools()).tools;
        expect(tools.map(tool => tool.name)).toEqual([
          "acpus_guide", "acpus_agent", "acpus_run", "acpus_list_runs", "acpus_inspect", "acpus_control", "acpus_artifact",
        ]);
        expect(tools.find(tool => tool.name === "acpus_run")?.annotations?.readOnlyHint).toBe(false);
        const context = toolData(await client.callTool({ name: "acpus_agent", arguments: { workspace } }));
        expect(context.workspace).toBe(workspace);
        expect(toolData(await client.callTool({ name: "acpus_list_runs", arguments: { workspace } }))).toEqual({ workspace, runs: [] });
        const error = await client.callTool({ name: "acpus_inspect", arguments: { workspace, runId: "missing" } });
        expect(error.isError).toBe(true);
        expect(error.structuredContent).toMatchObject({ error: { code: "RUNTIME_STORE_NOT_FOUND", next: expect.any(String) } });
        const invalid = await client.callTool({ name: "acpus_inspect", arguments: { workspace, runId: "missing", wait: "terminal", timeoutMs: 30_001 } });
        expect(invalid.isError).toBe(true);
      }, mode);
      expect(await readdir(home)).toEqual([]);
      expect(await readdir(workspace)).toEqual([]);
    });
  });

  it("requires one Run source and rejects conflicting fork replacements before lookup", async () => {
    await withPlainTestWorkspace("mcp-source-selection", async (workspace, home) => {
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      await withMcpClient(async client => {
        for (const call of [
          { name: "acpus_run", arguments: { workspace } },
          { name: "acpus_run", arguments: { workspace, source: "export default {};", file: "workflow.ts" } },
          { name: "acpus_control", arguments: { workspace, runId: "missing", action: { type: "fork", source: "export default {};", file: "workflow.ts" } } },
        ]) {
          const rejected = await client.callTool(call);
          expect(rejected.isError).toBe(true);
          expect(rejected.structuredContent).toBeUndefined();
        }
      });
    });
  });

  it("rejects invalid input and preserves compiler diagnostics before admitting a Run", async () => {
    await withPlainTestWorkspace("mcp-validation", async (workspace, home) => {
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      await withMcpClient(async client => {
        const invalidInput = await client.callTool({ name: "acpus_run", arguments: { workspace, file: "workflow.ts", input: {} } });
        expect(invalidInput.isError).toBe(true);
        expect(invalidInput.structuredContent).toMatchObject({ error: { code: "SCHEMA_MISMATCH", workspace } });
        expect(compiler.tryPrepareWorkflow).toHaveBeenCalledExactlyOnceWith({ workspaceDir: workspace, source: { kind: "path", entry: "workflow.ts" } });
        const diagnostics = [{ code: "TS2304", severity: "error" as const, message: "Unknown workflow value.", source: { file: "workflow.ts", line: 1, column: 16 } }];
        compiler.tryPrepareWorkflow.mockReturnValueOnce(Effect.fail({
          type: "check-failed", phase: "check", message: "Invalid workflow source.", diagnostics,
        }));
        const invalidSource = await client.callTool({ name: "acpus_run", arguments: { workspace,
          source: "export default missingSymbol;",
        } });
        expect(invalidSource.isError).toBe(true);
        expect(invalidSource.structuredContent).toMatchObject({ error: { code: "CHECK_FAILED", phase: "check", diagnostics, workspace } });
        expect(invalidSource.content).toEqual([{ type: "text", text: JSON.stringify(invalidSource.structuredContent) }]);
        expect(toolData(await client.callTool({ name: "acpus_list_runs", arguments: { workspace } })).runs).toEqual([]);
      });
      expect(await readdir(home)).toEqual([]);
    });
  });

  it("dry runs distinguish omitted input from explicit values and validate Agent bindings", async () => {
    await withPlainTestWorkspace("mcp-dry-run", async (workspace, home) => {
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      const source = "export default workflow;";
      await withMcpClient(async client => {
        for (const [args, unboundAgents] of [
          [{}, ["worker"]],
          [{ input: null, agents: { worker: { use: "codex" } } }, []],
        ] as const) {
          const checked = toolData(await client.callTool({ name: "acpus_run", arguments: { workspace, source, dryRun: true, ...args } }));
          expect(checked).toMatchObject({ workspace, dryRun: true, workflow: { name: "mcp-validation", nodeCount: 0 }, diagnostics: [], unboundAgents });
          expect(checked.runId).toBeUndefined();
        }
        const invalid = await client.callTool({ name: "acpus_run", arguments: { workspace, source, dryRun: true, input: {} } });
        expect(invalid.structuredContent).toMatchObject({ error: { code: "SCHEMA_MISMATCH", workspace } });
        expect(toolData(await client.callTool({ name: "acpus_list_runs", arguments: { workspace } })).runs).toEqual([]);
      });
      expect(await readdir(home)).toEqual([]);
    });
  });

  it("validates Agent bindings and returns only public authoring context", async () => {
    await withPlainTestWorkspace("mcp-agents", async (workspace, home) => {
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      await mkdir(join(workspace, ".acpus"));
      await writeFile(join(workspace, ".acpus/config.json"), JSON.stringify({ presets: {
        reviewer: { guidance: "Review changes", agent: { use: "codex", env: { PRIVATE_KEY: "secret-value" } } },
      } }));
      const source = "export default workflow;";
      await withMcpClient(async client => {
        const context = toolData(await client.callTool({ name: "acpus_agent", arguments: { workspace } }));
        expect(JSON.stringify(context)).not.toContain("secret-value");
        const invalid = await client.callTool({ name: "acpus_run", arguments: { workspace, source, dryRun: true, agents: { unknown: "codex" } } });
        expect(invalid.isError).toBe(true);
        expect(invalid.structuredContent).toMatchObject({ error: { code: "AGENT_INJECTIONS_INVALID", next: expect.any(String) } });
      });
    });
  });
});

it("keeps one server's Home fixed while concurrent project calls resolve their own workspaces", async () => {
  await withPlainTestWorkspace("mcp-projects", async (root, userHome) => {
    const acpusHome = join(userHome, "isolated");
    vi.stubEnv("ACPUS_HOME", acpusHome);
    await mkdir(acpusHome);
    await writeFile(join(acpusHome, "config.json"), JSON.stringify({ authoring: { agentScale: "small" } }));
    const projects = [join(root, "a"), join(root, "b")];
    for (const [i, workspace] of projects.entries()) {
      await mkdir(join(workspace, ".acpus"), { recursive: true });
      await writeFile(join(workspace, ".acpus/config.json"), JSON.stringify({ presets: {
        worker: { guidance: `project-${i}`, agent: { use: "codex" } },
      } }));
    }
    await withMcpClient(async client => {
      vi.stubEnv("ACPUS_HOME", join(userHome, "other"));
      const contexts = await Promise.all(projects.map(workspace => client.callTool({ name: "acpus_agent", arguments: { workspace } }).then(toolData)));
      for (const [i, context] of contexts.entries()) {
        expect(context).toMatchObject({ workspace: projects[i], acpusHome, scale: { value: "small" }, presets: { choices: [{ id: "worker", guidance: `project-${i}` }] } });
      }
      for (const args of [{}, { workspace: "." }, { workspace: join(root, "missing") }, { workspace: join(acpusHome, "config.json") }]) {
        expect((await client.callTool({ name: "acpus_agent", arguments: args })).isError).toBe(true);
      }
      const failed = await client.callTool({ name: "acpus_inspect", arguments: { workspace: projects[0], runId: "missing" } });
      expect(failed.structuredContent).toMatchObject({ error: { workspace: projects[0], runId: "missing" } });
    });
    expect(await readdir(acpusHome)).toEqual(["config.json"]);
  });
});
