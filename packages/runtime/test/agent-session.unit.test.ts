import type { AgentNodeIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import { resolveAgentSessionIdentity } from "../src/execution/agent-session.js";

describe("Agent session identity", () => {
  it("uses a short deterministic id for a node-local session", () => {
    const first = resolveAgentSessionIdentity(agentNode(), {}, "run-1", "node#1")._unsafeUnwrap();
    const second = resolveAgentSessionIdentity(agentNode(), {}, "run-1", "node#1")._unsafeUnwrap();

    expect(first).toEqual({ sessionName: "acpus-Mw48dJv0p2g2ep6TflAn_g" });
    expect(second).toEqual(first);
    expect(first.sessionName).toHaveLength(28);
    expect(resolveAgentSessionIdentity(agentNode(), {}, "run-1", "other-node")._unsafeUnwrap().sessionName)
      .not.toBe(first.sessionName);
  });

  it("preserves explicit shared-session identity within one run", () => {
    const first = resolveAgentSessionIdentity(agentNode("shared"), {}, "run-1", "node#1")._unsafeUnwrap();
    const second = resolveAgentSessionIdentity(agentNode("shared"), {}, "run-1", "other-node")._unsafeUnwrap();
    const otherRun = resolveAgentSessionIdentity(agentNode("shared"), {}, "run-2", "node#1")._unsafeUnwrap();

    expect(first).toEqual({
      sessionName: "acpus-RpuTCEVCtKjYYs3E9RMYrw",
      explicitSessionKey: "shared",
    });
    expect(second).toEqual(first);
    expect(otherRun.sessionName).toBe("acpus-rMG309IGR7FmwHN8U1Tx2g");
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
