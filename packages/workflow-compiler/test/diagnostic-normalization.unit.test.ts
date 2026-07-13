import type { DiagnosticIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import type { DiagnosticCandidate, DiagnosticOrigin } from "../src/check/diagnostics.js";
import { normalizeDiagnostics } from "../src/check/typescript.js";

const entry = "/work/workflow.ts";

describe("workflow diagnostic normalization", () => {
  it("orders infrastructure, entry source, and imported source diagnostics structurally", () => {
    const diagnostics = normalizeDiagnostics([
      candidate("entry-ts", "semantic", entry, 30, 31, 0),
      candidate("import-z", "semantic", "/work/z.ts", 1, 2, 1),
      candidate("syntax", "syntactic", entry, 100, 101, 2),
      candidate("entry-al", "authoring", entry, 20, 21, 3),
      candidate("config", "config", undefined, undefined, undefined, 4),
      candidate("import-a", "semantic", "/work/a.ts", 10, 11, 5),
    ], entry);

    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      "config",
      "syntax",
      "entry-al",
      "entry-ts",
      "import-a",
      "import-z",
    ]);
  });

  it("demotes a containing raw boundary diagnostic but retains a standalone raw diagnostic in source order", () => {
    const diagnostics = normalizeDiagnostics([
      candidate("standalone", "semantic", entry, 5, 6, 0),
      candidate("broad", "semantic", entry, 10, 100, 1),
      candidate("contained", "authoring", entry, 50, 60, 2),
    ], entry);

    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      "standalone",
      "contained",
      "broad",
    ]);
  });

  it("deduplicates only diagnostics with identical user-visible fields and drops hidden metadata", () => {
    const visible: DiagnosticIR = {
      code: "AL001",
      severity: "error",
      message: "same",
      source: { file: entry, line: 2, column: 3 },
      hint: "fix",
    };
    const diagnostics = normalizeDiagnostics([
      { diagnostic: visible, origin: "authoring", file: entry, start: 10, end: 11, sequence: 0 },
      { diagnostic: { ...visible }, origin: "semantic", file: entry, start: 20, end: 21, sequence: 1 },
      { diagnostic: { ...visible, source: { file: entry, line: 3, column: 3 } }, origin: "authoring", file: entry, start: 30, end: 31, sequence: 2 },
    ], entry);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map(diagnostic => diagnostic.source?.line)).toEqual([2, 3]);
    expect(Object.keys(diagnostics[0] ?? {})).toEqual(["code", "severity", "message", "source", "hint"]);
    expect(JSON.stringify(diagnostics)).not.toContain("origin");
    expect(JSON.stringify(diagnostics)).not.toContain("sequence");
  });
});

function candidate(
  message: string,
  origin: DiagnosticOrigin,
  file: string | undefined,
  start: number | undefined,
  end: number | undefined,
  sequence: number,
): DiagnosticCandidate {
  return {
    diagnostic: {
      code: `X${sequence}`,
      severity: "error",
      message,
      ...(file ? { source: { file, line: 1, column: (start ?? 0) + 1 } } : {}),
    },
    origin,
    sequence,
    ...(file ? { file } : {}),
    ...(start === undefined || end === undefined ? {} : { start, end }),
  };
}
