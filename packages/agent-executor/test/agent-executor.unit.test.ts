import { describe, expect, it } from "vitest";
import { executeAgentRequest, getProviderCommandFromEnv } from "@acpus/agent-executor";

describe("agent executor pure parsing", () => {
  it("parses mock output like command stdout", async () => {
    await expect(executeAgentRequest({ kind: "mock", prompt: "" })).resolves.toEqual({});
    await expect(executeAgentRequest({ kind: "mock", prompt: "{\"ok\":true}" })).resolves.toEqual({ ok: true });
    await expect(executeAgentRequest({ kind: "mock", prompt: "plain text" })).resolves.toEqual({ text: "plain text" });
  });

  it("resolves provider commands from ACPUS_AGENT_PROVIDER_COMMANDS", () => {
    expect(getProviderCommandFromEnv("local", { ACPUS_AGENT_PROVIDER_COMMANDS: "{\"local\":\"node worker.js\"}" })).toBe("node worker.js");
    expect(getProviderCommandFromEnv("missing", { ACPUS_AGENT_PROVIDER_COMMANDS: "{\"local\":\"node worker.js\"}" })).toBeUndefined();
    expect(() => getProviderCommandFromEnv("local", { ACPUS_AGENT_PROVIDER_COMMANDS: "{bad" })).toThrow("ACPUS_AGENT_PROVIDER_COMMANDS must be valid JSON.");
    expect(() => getProviderCommandFromEnv("local", { ACPUS_AGENT_PROVIDER_COMMANDS: "{\"local\":123}" })).toThrow("Provider command 'local' must be a non-empty string.");
  });
});
