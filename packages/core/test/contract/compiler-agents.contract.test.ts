import { describe, expect, it } from "vitest";
import { applyAgentOverrides, compileWorkflow, lintWorkflow } from "../../src/index.js";
import { parse as parseYaml } from "yaml";
import { expectDiagnostic } from "../support/diagnostic-helpers.js";

describe("@acpus/core compiler: agents", () => {
  it("defaults agent type to builtin and injects the resolved agent into node metadata", () => {
    const source = `
version: 1
name: agent-builtin-default
agents:
  coder: { use: pi, model: gpt-5 }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    const agent = agentNode.metadata.agent as { type?: string; use?: string; model?: string };
    expect(agent.type).toBe("builtin");
    expect(agent.use).toBe("pi");
    expect(agent.model).toBe("gpt-5");
  });

  it("accepts a command agent with a launch command", () => {
    const source = `
version: 1
name: agent-command
agents:
  custom: { type: command, use: "node ./acp-server.js" }
workflow:
  steps:
    - id: ask
      run: agent
      use: custom
      prompt: "x"
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    expect((agentNode.metadata.agent as { type?: string }).type).toBe("command");
  });

  it("rejects a command agent missing use", () => {
    const source = `
version: 1
name: agent-command-missing-use
agents:
  coder: { type: command }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "AGENT_SHAPE" });
  });

  it("rejects a builtin/command agent missing use", () => {
    const source = `
version: 1
name: agent-missing-use
agents:
  coder: { type: builtin }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "AGENT_SHAPE" });
  });

  it("rejects an agent with an unknown type", () => {
    const source = `
version: 1
name: agent-bad-type
agents:
  coder: { type: bogus, use: pi }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "AGENT_SHAPE" });
  });

  it("rejects agent steps that reference undeclared agents", () => {
    const source = `
version: 1
name: missing-agent-ref
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: ghost
      prompt: "x"
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "AGENT_REF" });
  });

  it("accepts an agent retry max of zero", () => {
    const source = `
version: 1
name: zero-retry
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      retry: { max: 0 }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(true);
  });

  it("rejects an agent retry with a negative max", () => {
    const source = `
version: 1
name: bad-retry
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      retry: { max: -1 }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "RETRY_SHAPE", message: "non-negative" });
  });

  it("rejects an agent retry with an invalid backoff", () => {
    const source = `
version: 1
name: bad-retry-backoff
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      retry: { max: 2, backoff: "soon" }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "RETRY_SHAPE" });
  });

  it("rejects an agent retry with unknown max_attempts and no valid max", () => {
    const source = `
version: 1
name: retry-wrong-key
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      retry: { max_attempts: 2 }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "RETRY_SHAPE", message: "Unknown" });
  });

  it("accepts a valid agent retry policy", () => {
    const source = `
version: 1
name: good-retry
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      retry: { max: 3, backoff: "500ms" }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(true);
  });

  it("compiles Agent Steps with overridden effective agent metadata", () => {
    const source = [
      "version: 1",
      "name: agent-override-compile",
      "agents:",
      "  implementer:",
      "    type: builtin",
      "    use: codex",
      "    model: gpt-5",
      "workflow:",
      "  steps:",
      "    - id: impl",
      "      run: agent",
      "      use: implementer",
      "      prompt: Do it."
    ].join("\n");
    const effective = applyAgentOverrides(parseYaml(source) as any, {
      implementer: { type: "builtin", use: "claude", model: "opus" }
    });
    const result = compileWorkflow(JSON.stringify(effective.effectiveSpec));

    expect(result.ok).toBe(true);
    const node = result.ir?.root.children?.[0];
    expect(node?.metadata.agent).toEqual({ type: "builtin", use: "claude", model: "opus" });
  });
});
