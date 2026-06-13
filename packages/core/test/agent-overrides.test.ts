import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyAgentOverrides, parseAgentOverridesInput } from "../src/agent-overrides.js";
import type { WorkflowSpec } from "../src/types.js";

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
        env: { A: "1", B: "2" },
        tools_allowlist: ["shell"]
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
  it("parses inline YAML and JSON objects", () => {
    expect(parseAgentOverridesInput("implementer: { model: gpt-5.1 }")).toEqual({
      implementer: { model: "gpt-5.1" }
    });
    expect(parseAgentOverridesInput('{"implementer":{"model":"gpt-5.1"}}')).toEqual({
      implementer: { model: "gpt-5.1" }
    });
  });

  it("parses existing JSON/YAML files and rejects missing path-like values", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-overrides-"));
    try {
      writeFileSync(join(dir, "agents.json"), JSON.stringify({ implementer: { model: "gpt-5.1" } }));
      writeFileSync(join(dir, "agents.yaml"), "implementer:\n  cwd: ./packages/core\n");
      expect(parseAgentOverridesInput("agents.json", dir)).toEqual({ implementer: { model: "gpt-5.1" } });
      expect(parseAgentOverridesInput("agents.yaml", dir)).toEqual({ implementer: { cwd: "./packages/core" } });
      expect(() => parseAgentOverridesInput("./missing.yaml", dir)).toThrow(/file not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid shapes and unsupported fields", () => {
    expect(() => parseAgentOverridesInput("[]")).toThrow(/object/);
    expect(() => parseAgentOverridesInput("implementer: {}")).toThrow(/must not be empty/);
    expect(() => parseAgentOverridesInput("implementer: { tools_allowlist: [] }")).toThrow(/not supported/);
    expect(() => parseAgentOverridesInput("implementer: { type: other, use: codex }")).toThrow(/builtin/);
    expect(() => parseAgentOverridesInput("implementer: { type: builtin }")).toThrow(/type and use together/);
    expect(() => parseAgentOverridesInput("implementer: { model: null }")).toThrow(/null/);
    expect(() => parseAgentOverridesInput("implementer: { cwd: null }")).toThrow(/cwd/);
    expect(() => parseAgentOverridesInput("implementer: { cwd: '' }")).toThrow(/cwd/);
    expect(() => parseAgentOverridesInput("implementer: { cwd: 42 }")).toThrow(/cwd/);
    expect(() => parseAgentOverridesInput("implementer: { cwd: [] }")).toThrow(/cwd/);
    expect(() => parseAgentOverridesInput("implementer: { cwd: { nested: true } }")).toThrow(/cwd/);
    expect(() => parseAgentOverridesInput("implementer: { env: [] }")).toThrow(/env/);
  });

  it("rejects unsupported file extensions and directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-overrides-"));
    try {
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "agents.txt"), "implementer: { model: gpt-5.1 }");
      expect(() => parseAgentOverridesInput("nested", dir)).toThrow(/directory/);
      expect(() => parseAgentOverridesInput("agents.txt", dir)).toThrow(/json/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      env: { A: "1", B: "override", C: "3" },
      tools_allowlist: ["shell"]
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
});
