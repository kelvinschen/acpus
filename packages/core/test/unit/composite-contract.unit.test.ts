import { describe, expect, it } from "vitest";
import { COMPOSITE_CONTRACTS } from "../../src/composite-contract.js";
import type { IrNodeKind } from "../../src/types.js";

// Every IrNodeKind the type system allows must have a contract entry. This is
// the mechanical guard against the failure mode where a new composite is added
// to the compiler but its scope/output semantics are forgotten here — the test
// goes red the moment a new kind appears in the IrNodeKind union.
const ALL_KINDS: IrNodeKind[] = [
  "pipeline",
  "run.agent",
  "run.program",
  "run.signal",
  "parallel",
  "fanout",
  "switch",
  "loop",
  "guard",
  "subworkflow"
];

describe("composite-contract universality", () => {
  it("registers a contract for every IrNodeKind", () => {
    for (const kind of ALL_KINDS) {
      expect(COMPOSITE_CONTRACTS[kind], `missing contract for kind '${kind}'`).toBeDefined();
    }
  });

  it("has no contract entries beyond the known kinds", () => {
    expect(Object.keys(COMPOSITE_CONTRACTS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("body-scoped locals are consistent with declared bodyLocals", () => {
    // fanout introduces item*, loop introduces loop; others introduce none.
    expect(COMPOSITE_CONTRACTS.fanout.bodyLocals).toContain("item");
    expect(COMPOSITE_CONTRACTS.loop.bodyLocals).toContain("loop");
    expect(COMPOSITE_CONTRACTS["run.agent"].bodyLocals).toEqual([]);
  });
});
