import { describe, expectTypeOf, it } from "vitest";
import type { CliResult } from "../src/output.js";

const catalog = {
  scope: "project",
  name: "release",
  packagePath: "/workspace/.acpus/workflows/release",
  entryPath: "/workspace/.acpus/workflows/release/workflow.ts",
  status: "available",
  requiresScope: false,
} as const;

function acceptResult(_result: CliResult): void {}

describe("CLI result type", () => {
  it("requires a complete import success and forbids import-only fields elsewhere", () => {
    const imported = { ok: true, phase: "import", catalog, checked: true } as const;
    acceptResult(imported);
    expectTypeOf(imported.checked).toEqualTypeOf<true>();

    // @ts-expect-error successful imports require checked
    acceptResult({ ok: true, phase: "import", catalog });
    // @ts-expect-error checked is only valid for import success
    acceptResult({ ok: true, phase: "check", checked: true });
    // @ts-expect-error import failure cannot expose catalog state
    acceptResult({ ok: false, phase: "import", catalog });
  });
});
