import { errAsync, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureStream } from "./support/capture-stream.js";

const mock = vi.hoisted(() => ({
  getAuthoringHealth: vi.fn(),
  getRuntimeHealth: vi.fn(),
  inspectRuntimeStore: vi.fn(),
  repairRuntimeStore: vi.fn(),
}));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  getRuntimeHealth: mock.getRuntimeHealth,
  inspectRuntimeStore: mock.inspectRuntimeStore,
  repairRuntimeStore: mock.repairRuntimeStore,
}));

vi.mock("../src/authoring-environment.js", () => ({
  getAuthoringHealth: mock.getAuthoringHealth,
}));

import { createDoctorCommand } from "../src/commands/doctor.js";

describe("Doctor repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getRuntimeHealth.mockResolvedValue(healthyReport());
    mock.inspectRuntimeStore.mockReturnValue(okAsync({ state: "ready" }));
    mock.repairRuntimeStore.mockReturnValue(okAsync({ changed: false }));
    mock.getAuthoringHealth.mockResolvedValue({
      checks: [],
      types: [
        { specifier: "acpus/core", typesPath: "/types/core.d.ts" },
        { specifier: "acpus/expression", typesPath: "/types/expression.d.ts" },
        { specifier: "acpus/tasks/git", typesPath: "/types/git.d.ts" },
      ],
    });
  });

  it("keeps ordinary Doctor read-only", async () => {
    const result = await runDoctor([]);

    expect(result.exitCode).toBe(0);
    expect(mock.getRuntimeHealth).toHaveBeenCalledOnce();
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
    expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
  });

  it("repairs only a repairable store and rechecks health", async () => {
    mock.inspectRuntimeStore.mockReturnValue(okAsync({
      state: "repairable",
      message: "Runtime store repair is required.",
    }));
    mock.repairRuntimeStore.mockReturnValue(okAsync({ changed: true }));

    const result = await runDoctor(["--fix"]);

    expect(result.exitCode).toBe(0);
    expect(mock.inspectRuntimeStore).toHaveBeenCalledWith("/workspace");
    expect(mock.repairRuntimeStore).toHaveBeenCalledWith("/workspace");
    expect(mock.getRuntimeHealth).toHaveBeenCalledOnce();
    expect(result.stdout).toContain("Runtime store fixed; existing runs were preserved.");
    expect(result.stderr).toBe("");
  });

  it("does not write when --fix finds a ready store", async () => {
    const result = await runDoctor(["--fix"]);

    expect(result.exitCode).toBe(0);
    expect(mock.inspectRuntimeStore).toHaveBeenCalledOnce();
    expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
  });

  it("reports a repair failure and does not pretend to recheck", async () => {
    mock.inspectRuntimeStore.mockReturnValue(okAsync({
      state: "repairable",
      message: "Runtime store repair is required.",
    }));
    mock.repairRuntimeStore.mockReturnValue(errAsync({
      type: "busy",
      message: "Runtime store is busy; retry after active work stops.",
    }));

    const result = await runDoctor(["--fix"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Runtime store is busy");
    expect(mock.getRuntimeHealth).not.toHaveBeenCalled();
  });
});

async function runDoctor(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  let exitCode = -1;
  const command = createDoctorCommand({
    cwd: "/workspace",
    stdout,
    stderr,
    setExitCode: code => { exitCode = code; },
  });
  await command.parseAsync(argv, { from: "user" });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

function healthyReport() {
  return {
    ok: true,
    phase: "doctor" as const,
    state: "ready" as const,
    persistence: { path: "/runtime/workspace" },
    checks: [{ area: "store" as const, status: "ok" as const, message: "Runtime store is ready." }],
  };
}
