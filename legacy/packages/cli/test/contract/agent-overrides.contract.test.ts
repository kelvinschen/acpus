import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentOverridesInput } from "../../src/agent-overrides.js";

describe("parseAgentOverridesInput", () => {
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

  it("validates parsed policy values", () => {
    expect(parseAgentOverridesInput("implementer: { policy: read }")).toEqual({
      implementer: { policy: "read" }
    });
    expect(parseAgentOverridesInput("reviewer: { policy: full }")).toEqual({
      reviewer: { policy: "full" }
    });
    expect(() => parseAgentOverridesInput("implementer: { policy: write }")).toThrow(/policy/);
  });
});
