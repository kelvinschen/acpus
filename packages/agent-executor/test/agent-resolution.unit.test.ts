import { describe, expect, it } from "vitest";
import { parseAcpAgentConfig } from "../src/agent-resolution.js";

describe("Acpus Agent config schema", () => {
  it("normalizes names and preserves shell command syntax exactly", () => {
    const result = parseAcpAgentConfig(JSON.stringify({
      agents: {
        " Custom-Agent ": "  custom-acp --label 'two words' --empty '' | wrapper \"$MODEL\"  ",
      },
    }), "/config/agents.json");

    expect([...result._unsafeUnwrap()]).toEqual([
      ["custom-agent", "  custom-acp --label 'two words' --empty '' | wrapper \"$MODEL\"  "],
    ]);
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-object document", "[]"],
    ["missing agents", JSON.stringify({})],
    ["extra top-level field", JSON.stringify({ agents: {}, version: 1 })],
    ["non-object agents", JSON.stringify({ agents: [] })],
    ["empty normalized name", JSON.stringify({ agents: { "  ": "agent" } })],
    ["normalized-name collision", JSON.stringify({
      agents: { Agent: "first", " agent ": "second" },
    })],
    ["empty command", JSON.stringify({ agents: { custom: "" } })],
    ["blank command", JSON.stringify({ agents: { custom: "  " } })],
    ["legacy argv object", JSON.stringify({ agents: { custom: { argv: ["agent"] } } })],
    ["command object", JSON.stringify({ agents: { custom: { command: "agent" } } })],
    ["array entry", JSON.stringify({ agents: { custom: ["agent"] } })],
    ["numeric entry", JSON.stringify({ agents: { custom: 1 } })],
  ])("rejects %s", (_case, content) => {
    const result = parseAcpAgentConfig(content, "/config/agents.json");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "agent-config",
      message: expect.stringContaining("/config/agents.json"),
    });
  });
});
