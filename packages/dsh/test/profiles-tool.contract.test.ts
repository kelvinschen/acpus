import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { registerSupervisorTools } from "../src/host/tools.js";

describe("acpus_profiles tool contract", () => {
  it("publishes changes-only input and revision-free results", async () => {
    const definitions: ToolDefinition[] = [];
    const updateAgentProfiles = vi.fn(async () => ({ status: "applied" as const }));
    const ctx = {
      tools: {
        register(definition: ToolDefinition) {
          definitions.push(definition);
        },
      },
      get(name: string) {
        return name === "acpusMode" ? { updateAgentProfiles } : undefined;
      },
    } as unknown as Context;
    registerSupervisorTools(ctx);

    const tool = definitions.find(definition => definition.name === "acpus_profiles");
    if (tool === undefined) throw new Error("Expected acpus_profiles to be registered.");
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["changes"],
      properties: { changes: { type: "array" } },
    });
    const properties = tool.parameters.properties;
    if (typeof properties !== "object" || properties === null) {
      throw new Error("Expected acpus_profiles parameter properties.");
    }
    expect(Object.keys(properties)).toEqual(["changes"]);

    const changes = [{
      operation: "set",
      profile: { id: "codex", use: "codex", guidance: "Coding." },
    }];
    await expect(tool.execute({ changes }, {} as never)).resolves.toEqual({ status: "applied" });
    expect(updateAgentProfiles).toHaveBeenCalledWith({ changes });
  });
});
