import { describe, it } from "vitest";
import type { CliResult } from "../src/presentation/output.js";

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
  it("closes fields and success states by phase", () => {
    const imported = { ok: true, phase: "import", message: "Imported.", catalog, checked: false } as const;
    acceptResult(imported);

    // @ts-expect-error successful imports require checked
    acceptResult({ ok: true, phase: "import", message: "Imported.", catalog });
    // @ts-expect-error checked imports require their preparation result
    acceptResult({ ok: true, phase: "import", message: "Imported.", catalog, checked: true });
    acceptResult({
      ok: true,
      phase: "import",
      message: "Imported.",
      catalog,
      checked: true,
      diagnostics: [],
      sourceGraphDigest: "sha256:checked",
    });
    // @ts-expect-error unchecked imports cannot expose preparation fields
    acceptResult({
      ok: true,
      phase: "import",
      message: "Imported.",
      catalog,
      checked: false,
      diagnostics: [],
      sourceGraphDigest: "sha256:unchecked",
    });
    // @ts-expect-error checked is only valid for import success
    acceptResult({ ok: true, phase: "check", checked: true });
    // @ts-expect-error import failure cannot expose catalog state
    acceptResult({ ok: false, phase: "import", catalog });
    acceptResult({ ok: true, phase: "inspect", catalog });
    acceptResult({ ok: true, phase: "inspect", catalogEntries: [catalog] });
    // @ts-expect-error catalog query results are self-describing and omit generic messages
    acceptResult({ ok: true, phase: "inspect", message: "Catalog shown.", catalog });
    // @ts-expect-error usage and compilation phases represent failures
    acceptResult({ ok: true, phase: "usage", message: "OK" });
    // @ts-expect-error usage and compilation phases represent failures
    acceptResult({ ok: true, phase: "compile", message: "OK" });
    // @ts-expect-error operational error codes are not part of check results
    acceptResult({ ok: false, phase: "check", errorCode: "CHECK_FAILED" });

    // @ts-expect-error successful run results cannot carry failure error codes
    acceptResult({ ok: true, phase: "run", message: "Started.", errorCode: "LISTEN_FAILED" });
    acceptResult({ ok: true, phase: "run", run: {} as never });
    // @ts-expect-error a workflow submission has no follow-up receipt field
    acceptResult({ ok: true, phase: "run", run: {} as never, followRunId: "run_1" });
    // @ts-expect-error a workflow submission has no preparation payload
    acceptResult({ ok: true, phase: "run", run: {} as never, sourceGraphDigest: "sha256:run" });
    // @ts-expect-error doctor results require the checks they summarize
    acceptResult({ ok: true, phase: "doctor", message: "OK" });
    // @ts-expect-error failed controls cannot advertise a follow-up run
    acceptResult({ ok: false, phase: "control", message: "Failed.", followRunId: "run_1" });
    // @ts-expect-error failed controls cannot carry an applied receipt
    acceptResult({ ok: false, phase: "control", message: "Failed.", control: { type: "pause", state: "applied", runId: "run_1" } });
    // @ts-expect-error successful controls require an applied or consumed receipt
    acceptResult({ ok: true, phase: "control", message: "OK", run: {} as never, control: { type: "pause", runId: "run_1" } });

    acceptResult({ ok: false, phase: "control", message: "Failed.", control: { type: "pause", runId: "run_1" } });
    acceptResult({
      ok: true,
      phase: "control",
      message: "Queued.",
      run: {} as never,
      control: {
        type: "steer",
        state: "applied",
        runId: "run_1",
        steerId: "cli:1",
        target: "review",
        delivery: "interrupt_continue",
        continuation: "queued",
      },
    });
    acceptResult({
      ok: true,
      phase: "control",
      message: "Forked.",
      run: {} as never,
      control: { type: "fork", state: "applied", sourceRunId: "run_source" },
      diagnostics: [],
      catalog,
    });
    // @ts-expect-error preparation fields belong only to replacement fork controls
    acceptResult({
      ok: true,
      phase: "control",
      message: "Paused.",
      run: {} as never,
      control: { type: "pause", state: "applied", runId: "run_1" },
      diagnostics: [],
    });
  });
});
