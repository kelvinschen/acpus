import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { registerSupervisorTools } from "../src/host/tools.js";

describe("Agent authoring tools contract", () => {
  it("exposes aggregated read and apply-only Preset tools", async () => {
    const definitions: ToolDefinition[] = [];
    const agentAuthoringContext = vi.fn(async () => ({
      scale: { value: "medium", maxAgentOccurrences: 12, source: "project" },
      presets: [{ id: "dsh", guidance: "Built-in DSH.", scope: "host" }],
    }));
    const applyAgentPresets = vi.fn(async () => ({ status: "applied" as const }));
    registerSupervisorTools(context(definitions, { agentAuthoringContext, applyAgentPresets }));

    const presetTool = tool(definitions);
    expect(presetTool.parameters).toMatchObject({
      type: "object",
      required: ["scope", "changes"],
      properties: {
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

    const agent = definitions.find(candidate => candidate.name === "acpus_agent");
    if (agent === undefined) throw new Error("Expected acpus_agent to be registered.");
    expect(agent.parameters).toEqual({ type: "object", properties: {} });
    expect(agent.isConcurrencySafe?.({})).toBe(true);
    await expect(agent.execute({}, execution())).resolves.toEqual({
      scale: { value: "medium", maxAgentOccurrences: 12, source: "project" },
      presets: [{ id: "dsh", guidance: "Built-in DSH.", scope: "host" }],
    });
    expect(agentAuthoringContext).toHaveBeenCalledWith("/workspace");
    await expect(agent.execute({ extra: true }, execution())).rejects.toMatchObject({
      code: "ACPUS_AGENT_CONTEXT_INVALID",
    });

    await expect(presetTool.execute({
      scope: "project",
    }, execution())).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(presetTool.execute({
      scope: "project",
      changes: [],
    }, execution())).rejects.toMatchObject({ code: "ACPUS_AGENT_PRESETS_INVALID" });
    expect(applyAgentPresets).not.toHaveBeenCalled();

    await expect(presetTool.execute({
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
