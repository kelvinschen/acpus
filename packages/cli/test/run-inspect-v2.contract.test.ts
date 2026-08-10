import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectionCandidates, InspectionError, InspectionView } from "@acpus/runtime";
import { createRunsCommand } from "../src/commands/runs.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({
  readInspection: vi.fn(),
}));
const follow = vi.hoisted(() => ({ followRun: vi.fn() }));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  readInspection: runtime.readInspection,
}));
vi.mock("../src/run-follow.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/run-follow.js")>(),
  followRun: follow.followRun,
}));

describe("runs inspect observation grammar", () => {
  beforeEach(() => {
    runtime.readInspection.mockReset().mockResolvedValue(ok(runView()));
    follow.followRun.mockReset().mockResolvedValue({
      kind: "closed",
      reason: "subject-terminal",
      run: { id: "run_1", status: "completed" },
    });
  });

  it("reads the coherent run view through the one Runtime query", async () => {
    const result = await runCommand(["inspect", "run_1"]);

    expect(result.exitCode).toBe(0);
    expect(runtime.readInspection).toHaveBeenCalledWith("/workspace", { kind: "run", runId: "run_1" });
    expect(result.stdout).toContain("Tree:");
  });

  it("renders every ambiguous Timeline candidate and preserves detail", async () => {
    runtime.readInspection.mockResolvedValue(ok(candidates()));

    const result = await runCommand(["inspect", "run_1", "--target", "review", "--timeline"]);

    expect(result.exitCode).toBe(0);
    expect(runtime.readInspection).toHaveBeenCalledWith("/workspace", {
      kind: "target", runId: "run_1", target: "review", detail: "timeline",
    });
    expect(result.stdout).toContain("Target review  matches=13");
    expect(result.stdout).toContain("Select: acpus runs inspect run_1 --target @000000000001 --timeline");
    expect(result.stdout).toContain("Select: acpus runs inspect run_1 --target @00000000000d --timeline");
    expect(result.stdout).not.toContain("Next:");
  });

  it("defaults Forensics to root and preserves it through candidate selection", async () => {
    await runCommand(["inspect", "run_1", "--forensics"]);
    expect(runtime.readInspection).toHaveBeenLastCalledWith("/workspace", {
      kind: "target", runId: "run_1", target: "root", detail: "forensics",
    });

    await runCommand(["inspect", "run_1", "--target", "root", "--forensics"]);
    expect(runtime.readInspection).toHaveBeenLastCalledWith("/workspace", {
      kind: "target", runId: "run_1", target: "root", detail: "forensics",
    });

    await runCommand(["inspect", "run_1", "--target", "@1a2b3c4d5e6f#2", "--forensics"]);
    expect(runtime.readInspection).toHaveBeenLastCalledWith("/workspace", {
      kind: "target", runId: "run_1", target: "@1a2b3c4d5e6f#2", detail: "forensics",
    });

    runtime.readInspection.mockResolvedValueOnce(ok(candidates()));
    const result = await runCommand(["inspect", "run_1", "--target", "review", "--forensics"]);
    expect(runtime.readInspection).toHaveBeenLastCalledWith("/workspace", {
      kind: "target", runId: "run_1", target: "review", detail: "forensics",
    });
    expect(result.stdout).toContain("Select: acpus runs inspect run_1 --target @000000000001 --forensics");
    expect(result.stdout).toContain("Select: acpus runs inspect run_1 --target @00000000000d --forensics");
  });

  it("maps terminal follow and decision waiting to distinct Runtime policies", async () => {
    await runCommand(["inspect", "run_1", "--target", "@1a2b3c4d5e6f", "--follow"]);
    expect(follow.followRun).toHaveBeenLastCalledWith("/workspace", {
      kind: "target",
      runId: "run_1",
      target: "@1a2b3c4d5e6f",
      detail: "summary",
    }, expect.objectContaining({ until: "subject-terminal" }));

    await runCommand(["inspect", "run_1", "--await-decision"]);
    expect(follow.followRun).toHaveBeenLastCalledWith("/workspace", {
      kind: "run",
      runId: "run_1",
    }, expect.objectContaining({ until: "decision-boundary" }));
    expect(runtime.readInspection).not.toHaveBeenCalled();
  });

  it("maps a blocking invalid query to usage exit 2", async () => {
    follow.followRun.mockResolvedValueOnce({
      kind: "error",
      error: { type: "invalid-query", message: "Target selector is malformed." },
    });

    const result = await runCommand(["inspect", "run_1", "--target", "@bad", "--follow"]);

    expect(result.exitCode).toBe(2);
    expect(follow.followRun).toHaveBeenCalledOnce();
  });

  it("keeps one-shot ambiguity successful while a Runtime query failure is operational", async () => {
    runtime.readInspection.mockResolvedValue(ok(candidates()));
    const ambiguous = await runCommand(["inspect", "run_1", "--target", "review"]);
    expect(ambiguous.exitCode).toBe(0);
    expect(ambiguous.stdout).toContain("Target review  matches=13");
    expect(ambiguous.stdout).toContain("Select: acpus runs inspect run_1 --target @000000000001");
    expect(ambiguous.stdout).toContain("Select: acpus runs inspect run_1 --target @00000000000d");
    expect(ambiguous.stdout).not.toContain("--timeline");
    expect(ambiguous.stdout).not.toContain("--forensics");

    const error: InspectionError = { type: "run-not-found", runId: "missing", message: "Run missing was not found." };
    runtime.readInspection.mockResolvedValue(err(error));
    await expect(runCommand(["inspect", "missing"])).rejects.toMatchObject({
      exitCode: 1,
      result: { phase: "inspect", errorCode: "RUN_NOT_FOUND" },
    });
  });
});

async function runCommand(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  let exitCode = -1;
  const command = createRunsCommand({
    cwd: "/workspace",
    stdin: Readable.from([]),
    stdout,
    stderr,
    setExitCode: code => { exitCode = code; },
  });
  await command.parseAsync(argv, { from: "user" });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

function runView(): Extract<InspectionView, { kind: "run" }> {
  return {
    kind: "run",
    run: { id: "run_1", name: "review", status: "running" },
    counts: { total: 1, running: 1 },
    tree: [],
  };
}

function candidates(): InspectionCandidates {
  return {
    kind: "candidates",
    run: { id: "run_1", status: "running" },
    target: "review",
    entries: Array.from({ length: 13 }, (_, index) => ({
      selector: `@${(index + 1).toString(16).padStart(12, "0")}`,
      status: index === 12 ? "completed" : "running",
      breadcrumb: `batch[${index}] › review`,
    })),
  };
}

function ok<T>(value: T): { isErr(): false; value: T } {
  return { isErr: () => false, value };
}

function err(error: InspectionError): { isErr(): true; error: InspectionError } {
  return { isErr: () => true, error };
}
