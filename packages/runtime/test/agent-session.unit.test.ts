import type { AgentNodeIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import { resolveAgentSessionIdentity } from "../src/execution/agent-session.js";

describe("Agent session identity", () => {
  it("locks the node-local scope and generation golden vectors", () => {
    const first = resolveAgentSessionIdentity(agentNode(), {}, "run-1", "agent~abc")._unsafeUnwrap();
    const second = resolveAgentSessionIdentity(agentNode(), {}, "run-1", "agent~abc", 2)._unsafeUnwrap();

    expect(first).toEqual({
      agentSessionId: "acpus-ec29acea756f750b2036306a307551059020c13952bbbd7d73ffb2e0166812b0-g1",
      scopeDigest: "sha256:ec29acea756f750b2036306a307551059020c13952bbbd7d73ffb2e0166812b0",
      generation: 1,
      explicitShared: false,
    });
    expect(second).toEqual({
      ...first,
      agentSessionId: "acpus-ec29acea756f750b2036306a307551059020c13952bbbd7d73ffb2e0166812b0-g2",
      generation: 2,
    });
  });

  it("locks the explicit shared Unicode scope golden vector", () => {
    const first = resolveAgentSessionIdentity(agentNode("team/α"), {}, "run-1", "node#1")._unsafeUnwrap();
    const second = resolveAgentSessionIdentity(agentNode("team/α"), {}, "run-1", "other-node")._unsafeUnwrap();

    expect(first).toEqual({
      agentSessionId: "acpus-75456fb6c293211e6eece5f13689ec5014b41bcded5e17deb0e84a21ad14ca8e-g1",
      scopeDigest: "sha256:75456fb6c293211e6eece5f13689ec5014b41bcded5e17deb0e84a21ad14ca8e",
      generation: 1,
      explicitShared: true,
      explicitSessionKey: "team/α",
    });
    expect(second).toEqual(first);
  });
});

function agentNode(sessionKey?: string): AgentNodeIR {
  return {
    id: "agent",
    kind: "agent",
    run: {
      agent: "worker",
      prompt: { kind: "literal", value: "work" },
      ...(sessionKey === undefined ? {} : { sessionKey: { kind: "literal", value: sessionKey } }),
    },
  };
}
