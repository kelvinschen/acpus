import { describe, it, expect } from "vitest";
import { hashIrNode } from "../src/hash.js";
import type { IrNode } from "../src/types.js";

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
});
