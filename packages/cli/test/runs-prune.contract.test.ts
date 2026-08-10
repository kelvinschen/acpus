import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PruneReport } from "@acpus/runtime";
import { createRunsCommand } from "../src/commands/runs.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({
  pruneRuns: vi.fn(),
}));
const prompts = vi.hoisted(() => ({
  confirm: vi.fn(),
}));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  pruneRuns: runtime.pruneRuns,
}));
vi.mock("@clack/prompts", async importOriginal => ({
  ...await importOriginal<typeof import("@clack/prompts")>(),
  confirm: prompts.confirm,
}));

const preview: PruneReport = {
  dryRun: true,
  selected: { workspaces: 2, runs: 3, archives: 1, bytes: 2_048 },
  deleted: { workspaces: 0, runs: 0, archives: 0, sources: 0, bytes: 0 },
  removedWorkspaces: 0,
  failures: [],
};

const agedPreview: PruneReport = {
  ...preview,
  cutoff: "2026-06-24T00:00:00.000Z",
};

const deleted: PruneReport = {
  ...preview,
  dryRun: false,
  deleted: { workspaces: 2, runs: 3, archives: 1, sources: 4, bytes: 2_048 },
  removedWorkspaces: 1,
};

describe("runs prune", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    runtime.pruneRuns.mockReset();
    prompts.confirm.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses selection options and emits a compact text dry-run report", async () => {
    runtime.pruneRuns.mockResolvedValue(agedPreview);

    const result = await runCommand(["prune", "--older-than", "30d", "--all-workspaces", "--dry-run"]);

    expect(runtime.pruneRuns).toHaveBeenCalledOnce();
    expect(runtime.pruneRuns).toHaveBeenCalledWith("/workspace", {
      olderThanMs: 2_592_000_000,
      allWorkspaces: true,
      dryRun: true,
      selectionCutoff: "2026-06-24T00:00:00.000Z",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Prune preview.\nSelected: 2 workspaces, 3 runs, 1 archive, 2048 bytes\n");
    expect(result.stderr).toBe("");
  });

  it("requires explicit consent for non-interactive deletion", async () => {
    await expect(runCommand(["prune"])).rejects.toMatchObject({
      exitCode: 2,
      result: { ok: false, phase: "usage" },
    });
    expect(runtime.pruneRuns).not.toHaveBeenCalled();
  });

  it("previews once, presents one aggregate TTY confirmation, then deletes", async () => {
    runtime.pruneRuns.mockResolvedValueOnce(preview).mockResolvedValueOnce(deleted);

    const result = await runCommand(["prune"], true);

    expect(runtime.pruneRuns.mock.calls).toEqual([
      ["/workspace", { allWorkspaces: false, dryRun: true, selectionCutoff: "2026-07-24T00:00:00.000Z" }],
      ["/workspace", { allWorkspaces: false, dryRun: false, selectionCutoff: "2026-07-24T00:00:00.000Z" }],
    ]);
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({
      initialValue: false,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("executes requested writable maintenance with --yes when the preview is empty", async () => {
    const empty: PruneReport = {
      ...preview,
      selected: { workspaces: 0, runs: 0, archives: 0, bytes: 0 },
    };
    const maintained: PruneReport = {
      ...empty,
      dryRun: false,
      removedWorkspaces: 1,
    };
    runtime.pruneRuns.mockResolvedValueOnce(empty).mockResolvedValueOnce(maintained);

    const result = await runCommand(["prune", "--yes"]);

    expect(runtime.pruneRuns.mock.calls).toEqual([
      ["/workspace", { allWorkspaces: false, dryRun: true, selectionCutoff: "2026-07-24T00:00:00.000Z" }],
      ["/workspace", { allWorkspaces: false, dryRun: false, selectionCutoff: "2026-07-24T00:00:00.000Z" }],
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Runs pruned.");
    expect(result.stdout).toContain("Removed workspaces: 1");
  });

  it("returns exit 1 and the final report when any workspace shard fails", async () => {
    const partial: PruneReport = {
      ...deleted,
      failures: [{
        workspaceKey: "f".repeat(32),
        message: "database is unreadable",
      }],
    };
    runtime.pruneRuns.mockResolvedValueOnce(preview).mockResolvedValueOnce(partial);

    const result = await runCommand(["prune", "--yes"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Run pruning completed with failures.");
    expect(result.stderr).toContain(`Failed: ${"f".repeat(32)}\tdatabase is unreadable`);
  });

  it("rejects invalid age durations before reading runtime state", async () => {
    await expect(runCommand(["prune", "--older-than", "1week", "--dry-run"])).rejects.toMatchObject({
      exitCode: 2,
      result: { ok: false, phase: "usage" },
    });
    expect(runtime.pruneRuns).not.toHaveBeenCalled();
  });
});

async function runCommand(argv: string[], tty = false): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdin = tty ? new TtyInput() : Readable.from([]);
  const stdout = tty ? new TtyCaptureStream() : new CaptureStream();
  const stderr = tty ? new TtyCaptureStream() : new CaptureStream();
  let exitCode = -1;
  const command = createRunsCommand({
    cwd: "/workspace",
    stdin,
    stdout,
    stderr,
    setExitCode: code => { exitCode = code; },
  });
  await command.parseAsync(argv, { from: "user" });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

class TtyInput extends Readable {
  readonly isTTY = true;

  setRawMode(_mode: boolean): this {
    return this;
  }

  override _read(): void {
    this.push(null);
  }
}

class TtyCaptureStream extends CaptureStream {
  readonly isTTY = true;
}
