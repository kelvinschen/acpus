import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  applyAgentPresetChanges,
  globalAcpusConfigPath,
  projectAcpusConfigPath,
  type AgentPresetChange,
  type WritableAgentPresetScope,
} from "@acpus/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSupervisorTools } from "../src/host/tools.js";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("acpus_presets tool contract", () => {
  it("exposes safe list/apply choices and rejects mixed operation inputs", async () => {
    const definitions: ToolDefinition[] = [];
    const agentPresetChoices = vi.fn(async () => [{
      id: "dsh",
      guidance: "Built-in DSH.",
      scope: "host" as const,
    }]);
    const applyAgentPresets = vi.fn(async () => ({ status: "applied" as const }));
    registerSupervisorTools(context(definitions, { agentPresetChoices, applyAgentPresets }));

    const presetTool = tool(definitions);
    expect(presetTool.parameters).toMatchObject({
      type: "object",
      required: ["operation"],
      properties: {
        operation: { enum: ["list", "apply"] },
        scope: { enum: ["project", "global"] },
        changes: {
          type: "array",
          items: {
            oneOf: [
              expect.objectContaining({
                required: ["operation", "id", "preset"],
                properties: expect.objectContaining({
                  operation: expect.objectContaining({ const: "set" }),
                }),
              }),
              expect.objectContaining({
                required: ["operation", "id"],
                properties: expect.objectContaining({
                  operation: expect.objectContaining({ const: "remove" }),
                }),
              }),
            ],
          },
        },
      },
    });

    await expect(presetTool.execute({ operation: "list" }, execution()))
      .resolves.toEqual({
        presets: [{ id: "dsh", guidance: "Built-in DSH.", scope: "host" }],
      });
    expect(agentPresetChoices).toHaveBeenCalledWith("/workspace");

    await expect(presetTool.execute({
      operation: "list",
      scope: "project",
    }, execution())).rejects.toMatchObject({ code: "ACPUS_AGENT_PRESETS_INVALID" });
    await expect(presetTool.execute({
      operation: "apply",
      scope: "project",
    }, execution())).rejects.toMatchObject({ code: "ACPUS_AGENT_PRESETS_INVALID" });
    expect(applyAgentPresets).not.toHaveBeenCalled();
  });

  it("maps set/remove operations and writes both shared project and global files", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-presets-"));
    const workspace = join(root, "workspace");
    const homeDir = join(root, "home");
    await Promise.all([mkdir(workspace), mkdir(homeDir)]);
    const definitions: ToolDefinition[] = [];
    const applyAgentPresets = vi.fn(async (input: {
      workspace: string;
      scope: WritableAgentPresetScope;
      changes: AgentPresetChange[];
    }) => {
      const applied = await applyAgentPresetChanges({
        workspaceDir: input.workspace,
        homeDir,
        scope: input.scope,
        changes: input.changes,
      });
      return applied.match(
        () => ({ status: "applied" as const }),
        failure => ({ status: "rejected" as const, reason: failure.type }),
      );
    });
    registerSupervisorTools(context(definitions, {
      agentPresetChoices: vi.fn(async () => []),
      applyAgentPresets,
    }));
    const presetTool = tool(definitions);
    const exec = execution(workspace);

    for (const scope of ["project", "global"] as const) {
      const path = scope === "project"
        ? projectAcpusConfigPath(workspace)
        : globalAcpusConfigPath(homeDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({
        agents: { worker: `${scope}-worker --stdio` },
        hooks: { "run.completed": [{ command: `echo ${scope}` }] },
      }));
      await expect(presetTool.execute({
        operation: "apply",
        scope,
        changes: [{
          operation: "set",
          id: `${scope}-coder`,
          preset: {
            guidance: `Use the ${scope} coder.`,
            agent: { use: "codex", model: "gpt-test" },
          },
        }],
      }, exec)).resolves.toEqual({ status: "applied" });
      await expect(readPresetFile(path)).resolves.toEqual({
        agents: { worker: `${scope}-worker --stdio` },
        presets: {
          [`${scope}-coder`]: {
            guidance: `Use the ${scope} coder.`,
            agent: { use: "codex", model: "gpt-test" },
          },
        },
        hooks: { "run.completed": [{ command: `echo ${scope}` }] },
      });

      await expect(presetTool.execute({
        operation: "apply",
        scope,
        changes: [{ operation: "remove", id: `${scope}-coder` }],
      }, exec)).resolves.toEqual({ status: "applied" });
      await expect(readPresetFile(path)).resolves.toEqual({
        agents: { worker: `${scope}-worker --stdio` },
        hooks: { "run.completed": [{ command: `echo ${scope}` }] },
      });
    }

    expect(applyAgentPresets).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scope: "project",
      changes: [{
        type: "set",
        id: "project-coder",
        preset: {
          guidance: "Use the project coder.",
          agent: { use: "codex", model: "gpt-test" },
        },
      }],
    }));
    expect(applyAgentPresets).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: "project",
      changes: [{ type: "remove", id: "project-coder" }],
    }));
  });
});

function context(
  definitions: ToolDefinition[],
  mode: Record<string, unknown>,
): Context {
  return {
    tools: {
      register(definition: ToolDefinition) {
        definitions.push(definition);
      },
    },
    get(name: string) {
      return name === "acpusMode" ? mode : undefined;
    },
  } as unknown as Context;
}

function tool(definitions: ToolDefinition[]): ToolDefinition {
  const definition = definitions.find(candidate => candidate.name === "acpus_presets");
  if (definition === undefined) throw new Error("Expected acpus_presets to be registered.");
  return definition;
}

function execution(workspace = "/workspace") {
  return {
    agent: { session: { header: { cwd: workspace } } },
  } as never;
}

async function readPresetFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
