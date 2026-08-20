import { Readable } from "node:stream";
import type { InspectionError } from "@acpus/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRunsCommand } from "../src/runs/command.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({
  observeInspection: vi.fn(),
  readInspection: vi.fn(),
  requestDaemonInspection: vi.fn(),
}));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  observeInspection: runtime.observeInspection,
  readInspection: runtime.readInspection,
  requestDaemonInspection: runtime.requestDaemonInspection,
}));

describe("runs inspect archived summaries", () => {
  beforeEach(() => {
    runtime.readInspection.mockReset().mockResolvedValue(archivedRun());
    runtime.requestDaemonInspection.mockReset().mockResolvedValue({
      isOk: () => false,
      isErr: () => true,
      error: { type: "rejected", code: "RUN_NOT_FOUND", message: "Run was not active." },
    });
    runtime.observeInspection.mockReset().mockImplementation(() => emissions([
      err(archivedDetailUnavailable()),
    ]));
  });

  it("renders the portable summary without exposing storage internals", async () => {
    const result = await runCommand(["inspect", "run_archived"]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        "Archived run run_archived",
        "Name: archived review",
        "Status: historical_custom_status",
        "Created: 2026-07-01T00:00:00.000Z",
        "Updated: 2026-07-02T00:00:00.000Z",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(runtime.readInspection).toHaveBeenCalledWith("/workspace", { kind: "run", runId: "run_archived" });
    expect(result.stdout).not.toMatch(/generation|storage/iu);
  });

  it.each([
    ["target", ["--target", "root"]],
    ["timeline", ["--target", "root", "--timeline"]],
    ["forensics", ["--forensics"]],
  ] as const)("rejects archived %s detail", async (_name, flags) => {
    runtime.readInspection.mockResolvedValue(err(archivedDetailUnavailable()));
    await expect(runCommand(["inspect", "run_archived", ...flags])).rejects.toMatchObject({
      exitCode: 1,
      result: {
        phase: "inspect",
        errorCode: "ARCHIVED_RUN_DETAIL_UNAVAILABLE",
        message: "Archived run 'run_archived' only has a summary. Run 'acpus runs inspect run_archived'.",
      },
    });
  });

  it.each([
    ["follow", ["--follow"]],
    ["await-decision", ["--await-decision"]],
  ] as const)("rejects archived %s without a preliminary read", async (_name, flags) => {
    const result = await runCommand(["inspect", "run_archived", ...flags]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error code: ARCHIVED_RUN_DETAIL_UNAVAILABLE");
    expect(result.stderr).toContain("acpus runs inspect run_archived");
    expect(runtime.readInspection).not.toHaveBeenCalled();
  });

  it("preserves an unavailable archived lookup instead of claiming not-found", async () => {
    runtime.readInspection.mockResolvedValue(err({
      type: "archived-run-lookup-unavailable",
      runId: "run_unknown",
      message: "Archived history cannot be searched for run 'run_unknown'.",
    }));

    await expect(runCommand(["inspect", "run_unknown"])).rejects.toMatchObject({
      exitCode: 1,
      result: {
        phase: "inspect",
        errorCode: "ARCHIVED_RUN_LOOKUP_UNAVAILABLE",
      },
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

function archivedRun() {
  return ok({
    kind: "archived-run" as const,
    run: {
      id: "run_archived",
      name: "archived review",
      status: "historical_custom_status",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    },
  });
}

function ok<T>(value: T): { isErr(): false; value: T } {
  return { isErr: () => false, value };
}

function err(error: InspectionError): { isErr(): true; error: InspectionError } {
  return { isErr: () => true, error };
}

function archivedDetailUnavailable(): InspectionError {
  return {
    type: "archived-run-detail-unavailable",
    runId: "run_archived",
    command: "acpus runs inspect run_archived",
    message: "Archived run 'run_archived' only has a summary. Run 'acpus runs inspect run_archived'.",
  };
}

function emissions(results: Array<ReturnType<typeof err>>) {
  return (async function* () {
    for (const result of results) yield result;
  })();
}
