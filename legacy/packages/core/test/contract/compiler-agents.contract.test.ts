import { describe, expect, it } from "vitest";
import { applyAgentOverrides, compileWorkflow, hashIrNode, lintWorkflow } from "../../src/index.js";
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

  it("carries a step-level cwd into agent node metadata", () => {
    const source = `
version: 1
name: agent-step-cwd
agents:
  coder: { use: pi, cwd: "/default" }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
      cwd: "\${{ input.target }}"
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    expect(agentNode.metadata.cwd).toBe("${{ input.target }}");
    // The agent definition's own cwd remains snapshotted for fallback.
    expect((agentNode.metadata.agent as { cwd?: string }).cwd).toBe("/default");
  });

  it("snapshots agent definition policy into metadata.agent.policy", () => {
    const source = `
version: 1
name: agent-policy-read
agents:
  reviewer: { use: pi, policy: read }
workflow:
  steps:
    - id: ask
      run: agent
      use: reviewer
      prompt: "x"
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    expect((agentNode.metadata.agent as { policy?: string }).policy).toBe("read");
    // Step-level policy is absent when not declared on the step.
    expect(agentNode.metadata.policy).toBeUndefined();
  });

  it("stores step-level policy in metadata.policy", () => {
    const source = `
version: 1
name: step-policy-full
agents:
  coder: { use: pi }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
      policy: full
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    expect(agentNode.metadata.policy).toBe("full");
    // Agent definition has no policy declared.
    expect((agentNode.metadata.agent as { policy?: string }).policy).toBeUndefined();
  });

  it("preserves both step-level and agent-level policy in IR", () => {
    const source = `
version: 1
name: both-policies
agents:
  coder: { use: pi, policy: read }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
      policy: full
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    expect(agentNode.metadata.policy).toBe("full");
    expect((agentNode.metadata.agent as { policy?: string }).policy).toBe("read");
  });

  it("snapshots policy on a command agent into metadata.agent.policy", () => {
    const source = `
version: 1
name: command-agent-policy
agents:
  reviewer: { type: command, use: "node ./review.js", policy: read }
workflow:
  steps:
    - id: ask
      run: agent
      use: reviewer
      prompt: "x"
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    expect((agentNode.metadata.agent as { type?: string; policy?: string }).type).toBe("command");
    expect((agentNode.metadata.agent as { policy?: string }).policy).toBe("read");
    // No step-level policy declared.
    expect(agentNode.metadata.policy).toBeUndefined();
  });

  it("stores step-level policy: read overriding agent-level policy: full", () => {
    const source = `
version: 1
name: step-read-agent-full
agents:
  coder: { use: pi, policy: full }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
      policy: read
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    expect(agentNode.metadata.policy).toBe("read");
    expect((agentNode.metadata.agent as { policy?: string }).policy).toBe("full");
  });

  it("produces different Node Definition Hash for different policy values", () => {
    const sourceRead = `
version: 1
name: hash-test
agents:
  coder: { use: pi, policy: read }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
`;
    const sourceFull = `
version: 1
name: hash-test
agents:
  coder: { use: pi, policy: full }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
`;
    const resultRead = compileWorkflow(sourceRead);
    const resultFull = compileWorkflow(sourceFull);

    expect(resultRead.ok).toBe(true);
    expect(resultFull.ok).toBe(true);

    const nodeRead = resultRead.ir!.root.children!.find((n) => n.id === "ask")!;
    const nodeFull = resultFull.ir!.root.children!.find((n) => n.id === "ask")!;

    // The Node Definition Hash must differ because metadata.agent.policy
    // differs, and nodeShape includes the full metadata object.
    expect(hashIrNode(nodeRead)).not.toBe(hashIrNode(nodeFull));
  });
});
