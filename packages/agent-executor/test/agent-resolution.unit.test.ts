import { describe, expect, it } from "vitest";
import { parseAcpAgentConfig } from "../src/agent-resolution.js";

describe("Acpus Agent config schema", () => {
  it("normalizes names and preserves structured argv, including empty arguments", () => {
    const result = parseAcpAgentConfig(JSON.stringify({
      agents: {
        " Custom-Agent ": { argv: ["custom-acp", "--label", ""] },
      },
    }), "/config/agents.json");

    expect([...result._unsafeUnwrap()]).toEqual([
      ["custom-agent", ["custom-acp", "--label", ""]],
    ]);
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-object document", "[]"],
    ["missing agents", JSON.stringify({})],
    ["extra top-level field", JSON.stringify({ agents: {}, version: 1 })],
    ["non-object agents", JSON.stringify({ agents: [] })],
    ["empty normalized name", JSON.stringify({ agents: { "  ": { argv: ["agent"] } } })],
    ["normalized-name collision", JSON.stringify({
      agents: { Agent: { argv: ["first"] }, " agent ": { argv: ["second"] } },
    })],
    ["command entry", JSON.stringify({ agents: { custom: { command: "agent" } } })],
    ["entry with extra field", JSON.stringify({
      agents: { custom: { argv: ["agent"], description: "extra" } },
    })],
    ["empty argv", JSON.stringify({ agents: { custom: { argv: [] } } })],
    ["blank executable", JSON.stringify({ agents: { custom: { argv: ["  "] } } })],
    ["non-string argument", JSON.stringify({ agents: { custom: { argv: ["agent", 1] } } })],
  ])("rejects %s", (_case, content) => {
    const result = parseAcpAgentConfig(content, "/config/agents.json");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "agent-config",
      message: expect.stringContaining("/config/agents.json"),
    });
  });
});
