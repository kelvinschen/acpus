import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { registerSupervisorTools } from "../src/host/tools.js";

describe("acpus_presets tool contract", () => {
  it("exposes safe list/apply choices and rejects mixed operation inputs", async () => {
    const definitions: ToolDefinition[] = [];
    const agentPresetChoices = vi.fn(async () => [{
      id: "dsh",
      guidance: "Built-in DSH.",
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
        presets: [{ id: "dsh", guidance: "Built-in DSH." }],
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

    await expect(presetTool.execute({
      operation: "apply",
      scope: "project",
      changes: [{
        operation: "set",
        id: "project-coder",
        preset: {
          guidance: "Use the project coder.",
          agent: { use: "codex", model: "gpt-test" },
        },
      }, { operation: "remove", id: "old-coder" }],
    }, execution())).resolves.toEqual({ status: "applied" });
    expect(applyAgentPresets).toHaveBeenCalledWith({
      workspace: "/workspace",
      scope: "project",
      changes: [{
        type: "set",
        id: "project-coder",
        preset: {
          guidance: "Use the project coder.",
          agent: { use: "codex", model: "gpt-test" },
        },
      }, { type: "remove", id: "old-coder" }],
    });
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
