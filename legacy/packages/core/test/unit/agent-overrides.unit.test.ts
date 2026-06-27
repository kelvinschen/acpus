import { describe, expect, it } from "vitest";
import { applyAgentOverrides, validateAgentOverrides } from "../../src/agent-overrides.js";
import type { WorkflowSpec } from "../../src/types.js";

function spec(): WorkflowSpec {
  return {
    version: 1,
    name: "override-demo",
    agents: {
      implementer: {
        type: "builtin",
        use: "codex",
        model: "gpt-5",
        cwd: "./old",
        env: { A: "1", B: "2" }
      },
      reviewer: {
        type: "builtin",
        use: "claude"
      }
    },
    workflow: {
      steps: [
        { id: "impl", run: "agent", use: "implementer", prompt: "Do it." }
      ]
    }
  };
}

describe("Agent Overrides", () => {
  it("rejects invalid shapes and unsupported fields", () => {
    expect(() => validateAgentOverrides([])).toThrow(/object/);
    expect(() => validateAgentOverrides({ implementer: {} })).toThrow(/must not be empty/);
    expect(() => validateAgentOverrides({ implementer: { tools_allowlist: [] } })).toThrow(/not supported/);
    expect(() => validateAgentOverrides({ implementer: { type: "other", use: "codex" } })).toThrow(/builtin/);
    expect(() => validateAgentOverrides({ implementer: { type: "builtin" } })).toThrow(/type and use together/);
    expect(() => validateAgentOverrides({ implementer: { model: null } })).toThrow(/null/);
    expect(() => validateAgentOverrides({ implementer: { cwd: null } })).toThrow(/cwd/);
    expect(() => validateAgentOverrides({ implementer: { cwd: "" } })).toThrow(/cwd/);
    expect(() => validateAgentOverrides({ implementer: { cwd: 42 } })).toThrow(/cwd/);
    expect(() => validateAgentOverrides({ implementer: { cwd: [] } })).toThrow(/cwd/);
    expect(() => validateAgentOverrides({ implementer: { cwd: { nested: true } } })).toThrow(/cwd/);
    expect(() => validateAgentOverrides({ implementer: { env: [] } })).toThrow(/env/);
  });

  it("merges scalar fields and env key-level without deleting other agent fields", () => {
    const result = applyAgentOverrides(spec(), {
      implementer: { model: "gpt-5.1", cwd: "./packages/core", env: { B: "override", C: "3" } }
    });

    expect(result.warnings).toEqual([]);
    expect(result.agentOverrides).toEqual({
      implementer: { model: "gpt-5.1", cwd: "./packages/core", env: { B: "override", C: "3" } }
    });
    expect(result.effectiveSpec.agents?.implementer).toEqual({
      type: "builtin",
      use: "codex",
      model: "gpt-5.1",
      cwd: "./packages/core",
      env: { A: "1", B: "override", C: "3" }
    });
  });

  it("clears model when identity changes without an explicit model", () => {
    const result = applyAgentOverrides(spec(), {
      implementer: { type: "command", use: "node ./agent.js" }
    });

    expect(result.effectiveSpec.agents?.implementer.model).toBeUndefined();
    expect(result.agentOverrides.implementer).toEqual({ type: "command", use: "node ./agent.js" });
    expect(result.warnings).toEqual([
      {
        code: "AGENT_MODEL_CLEARED",
        agent: "implementer",
        message: "Agent Override for 'implementer' changed type/use and cleared the inherited model."
      }
    ]);
  });

  it("preserves cwd and env when identity changes", () => {
    const result = applyAgentOverrides(spec(), {
      implementer: { type: "command", use: "node ./agent.js", env: { B: "override" } }
    });

    expect(result.effectiveSpec.agents?.implementer.cwd).toBe("./old");
    expect(result.effectiveSpec.agents?.implementer.env).toEqual({ A: "1", B: "override" });
  });

  it("rejects current overrides for unknown agents", () => {
    expect(() => applyAgentOverrides(spec(), { missing: { model: "gpt-5.1" } })).toThrow(/does not match/);
  });

  it("skips inherited overrides for removed agents but blocks current unknown agents", () => {
    const result = applyAgentOverrides(spec(), undefined, {
      inherited: {
        implementer: { model: "gpt-5.1" },
        removed: { model: "gpt-4.1" }
      }
    });

    expect(result.agentOverrides).toEqual({ implementer: { model: "gpt-5.1" } });
    expect(result.warnings).toContainEqual({
      code: "INHERITED_AGENT_OVERRIDE_SKIPPED",
      agent: "removed",
      message: "Inherited Agent Override for 'removed' was skipped because the repaired Workflow Spec does not declare that agent."
    });
  });

  it("validates policy: read", () => {
    expect(validateAgentOverrides({ implementer: { policy: "read" } })).toEqual({
      implementer: { policy: "read" }
    });
  });

  it("validates policy: full", () => {
    expect(validateAgentOverrides({ reviewer: { policy: "full" } })).toEqual({
      reviewer: { policy: "full" }
    });
  });

  it("rejects invalid policy value in --agents", () => {
    expect(() => validateAgentOverrides({ implementer: { policy: "write" } })).toThrow(/policy/);
  });

  it("override policy replaces agent definition policy", () => {
    const readSpec: WorkflowSpec = {
      version: 1,
      name: "policy-override",
      agents: {
        implementer: {
          type: "builtin",
          use: "codex",
          policy: "full"
        }
      },
      workflow: {
        steps: [
          { id: "impl", run: "agent", use: "implementer", prompt: "Do it." }
        ]
      }
    };
    const result = applyAgentOverrides(readSpec, {
      implementer: { policy: "read" }
    });

    expect(result.effectiveSpec.agents?.implementer.policy).toBe("read");
    expect(result.agentOverrides.implementer).toEqual({ policy: "read" });
  });

  it("preserves policy when identity changes (unlike model)", () => {
    const policySpec: WorkflowSpec = {
      version: 1,
      name: "policy-identity",
      agents: {
        reviewer: {
          type: "builtin",
          use: "claude",
          model: "gpt-5",
          policy: "read"
        }
      },
      workflow: {
        steps: [
          { id: "rev", run: "agent", use: "reviewer", prompt: "Review it." }
        ]
      }
    };
    const result = applyAgentOverrides(policySpec, {
      reviewer: { type: "command", use: "node ./agent.js" }
    });

    // Model is cleared on identity change (with warning).
    expect(result.effectiveSpec.agents?.reviewer.model).toBeUndefined();
    // Policy is preserved — it is orthogonal to agent identity.
    expect(result.effectiveSpec.agents?.reviewer.policy).toBe("read");
    expect(result.warnings).toContainEqual({
      code: "AGENT_MODEL_CLEARED",
      agent: "reviewer",
      message: "Agent Override for 'reviewer' changed type/use and cleared the inherited model."
    });
  });
});
