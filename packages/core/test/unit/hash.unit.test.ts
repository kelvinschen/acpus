import { describe, it, expect } from "vitest";
import { compileWorkflow, hashIrNode } from "../../src/index.js";
import { applyAgentOverrides } from "../../src/agent-overrides.js";
import { parse as parseYaml } from "yaml";
import type { IrNode } from "../../src/types.js";

function programNode(metadata: Record<string, unknown>): IrNode {
  return {
    id: "step",
    kind: "run.program",
    nodePath: ["workflow", "step"],
    keyTemplate: { astVersion: 1, nodePath: "workflow/step" },
    metadata
  };
}

describe("hashIrNode", () => {
  it("returns the same hash for structurally identical nodes", () => {
    const a = programNode({ run: "program", cmd: "ls" });
    const b = programNode({ run: "program", cmd: "ls" });
    expect(hashIrNode(a)).toBe(hashIrNode(b));
  });

  it("changes when cmd changes", () => {
    const a = programNode({ run: "program", cmd: "ls" });
    const b = programNode({ run: "program", cmd: "ls -la" });
    expect(hashIrNode(a)).not.toBe(hashIrNode(b));
  });

  it("changes when expect.exit_code changes", () => {
    const a = programNode({ run: "program", cmd: "pnpm test" });
    const b = programNode({ run: "program", cmd: "pnpm test", expect: { exit_code: [0, 1] } });
    expect(hashIrNode(a)).not.toBe(hashIrNode(b));
  });

  it("ignores object key insertion order in metadata", () => {
    const a = programNode({ run: "program", cmd: "ls", env: { A: "1", B: "2" } });
    const b = programNode({ env: { B: "2", A: "1" }, cmd: "ls", run: "program" });
    expect(hashIrNode(a)).toBe(hashIrNode(b));
  });

  it("includes children in composite hashes", () => {
    const child = programNode({ run: "program", cmd: "ls" });
    const composite: IrNode = {
      id: "outer",
      kind: "pipeline",
      nodePath: ["workflow"],
      keyTemplate: { astVersion: 1, nodePath: "workflow" },
      metadata: {},
      children: [child]
    };
    const childChanged: IrNode = {
      ...composite,
      children: [programNode({ run: "program", cmd: "ls -la" })]
    };
    expect(hashIrNode(composite)).not.toBe(hashIrNode(childChanged));
  });

  it("excludes node id and nodePath (identity carried by Node Key)", () => {
    const a: IrNode = {
      id: "step-a",
      kind: "run.program",
      nodePath: ["workflow", "step-a"],
      keyTemplate: { astVersion: 1, nodePath: "workflow/step-a" },
      metadata: { run: "program", cmd: "ls" }
    };
    const b: IrNode = {
      id: "step-b",
      kind: "run.program",
      nodePath: ["workflow", "step-b"],
      keyTemplate: { astVersion: 1, nodePath: "workflow/step-b" },
      metadata: { run: "program", cmd: "ls" }
    };
    expect(hashIrNode(a)).toBe(hashIrNode(b));
  });

  it("matches hashes for equivalent effective IR from spec defaults and overrides", () => {
    const defaultSource = [
      "version: 1",
      "name: hash-agent-default",
      "agents:",
      "  implementer:",
      "    type: builtin",
      "    use: claude",
      "    model: opus",
      "workflow:",
      "  steps:",
      "    - id: impl",
      "      run: agent",
      "      use: implementer",
      "      prompt: Do it."
    ].join("\n");
    const overrideSource = defaultSource.replace("use: claude", "use: codex").replace("model: opus", "model: gpt-5");
    const effective = applyAgentOverrides(parseYaml(overrideSource) as any, {
      implementer: { type: "builtin", use: "claude", model: "opus" }
    });
    const defaultIr = compileWorkflow(defaultSource).ir!;
    const overrideIr = compileWorkflow(JSON.stringify(effective.effectiveSpec)).ir!;

    expect(hashIrNode(defaultIr.root.children![0]!)).toBe(hashIrNode(overrideIr.root.children![0]!));
  });

  it("changes referenced Agent Step hash when agent identity changes", () => {
    const source = [
      "version: 1",
      "name: hash-agent-change",
      "agents:",
      "  implementer:",
      "    type: builtin",
      "    use: codex",
      "workflow:",
      "  steps:",
      "    - id: impl",
      "      run: agent",
      "      use: implementer",
      "      prompt: Do it."
    ].join("\n");
    const effective = applyAgentOverrides(parseYaml(source) as any, {
      implementer: { type: "builtin", use: "claude" }
    });
    const originalIr = compileWorkflow(source).ir!;
    const overrideIr = compileWorkflow(JSON.stringify(effective.effectiveSpec)).ir!;

    expect(hashIrNode(originalIr.root.children![0]!)).not.toBe(hashIrNode(overrideIr.root.children![0]!));
  });
});
