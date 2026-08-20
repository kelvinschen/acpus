import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskNodeIR } from "@acpus/core/ir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, okAsync } from "neverthrow";
import type { TaskExecutorOptions } from "../src/execution/task-executor.js";
import { executeTaskNode } from "../src/execution/task-executor.js";
import { resolveRuntimeLayout, setRuntimeHomeForTest } from "../src/runtime-layout.js";
import type { ArtifactRecord, RegisterArtifactInput } from "../src/artifacts/types.js";
import { captureDirectoryIdentity } from "../src/store/path-fence.js";
import { inlineTask } from "./support/task-executor-fixture.js";
import type { TaskAttemptRunner } from "./support/task-attempt-harness.js";

const taskProcessMocks = vi.hoisted(() => ({
  runTaskAttempt: vi.fn<TaskAttemptRunner>(),
}));
let taskRuntimeRoot: string;

vi.mock("../src/execution/task-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/execution/task-process.js")>(),
  runTaskAttempt: taskProcessMocks.runTaskAttempt,
}));

beforeEach(() => {
  taskRuntimeRoot = mkdtempSync(join(tmpdir(), "acpus-task-executor-unit-"));
  taskProcessMocks.runTaskAttempt.mockReset();
});

afterEach(() => {
  rmSync(taskRuntimeRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("task executor rules", () => {
  it("preserves an own __proto__ Task input field without changing its prototype", async () => {
    taskProcessMocks.runTaskAttempt.mockReturnValue(okAsync({ ok: true }));
    const authoredInput: TaskNodeIR["run"]["input"] = {
      kind: "object",
      fields: Object.fromEntries([
        ["__proto__", {
          kind: "object",
          fields: { safe: { kind: "literal", value: true } },
        }] as const,
      ]),
    };

    const result = await executeTaskNode(
      inlineTask("proto_input", "async () => ({ ok: true })", {
        input: authoredInput,
      }),
      {},
      taskOptions("run_proto_input"),
    );

    expect(result.isOk()).toBe(true);
    const input = taskProcessMocks.runTaskAttempt.mock.calls[0]?.[0].request.input;
    expect(input).toBeDefined();
    if (input === undefined || input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Task attempt was not dispatched with an object input.");
    }
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect(Object.hasOwn(input, "__proto__")).toBe(true);
    expect(JSON.stringify(input)).toBe('{"__proto__":{"safe":true}}');
  });

  it.each([
    ["primitive", { kind: "literal", value: "raw" } satisfies TaskNodeIR["run"]["input"], "raw"],
    ["null", { kind: "literal", value: null } satisfies TaskNodeIR["run"]["input"], null],
    ["array", { kind: "array", items: [{ kind: "literal", value: "raw" }, { kind: "literal", value: 2 }] } satisfies TaskNodeIR["run"]["input"], ["raw", 2]],
  ])("passes exact %s Task input through metadata and the Task attempt request", async (_name, authoredInput, expected) => {
    taskProcessMocks.runTaskAttempt.mockReturnValue(okAsync({ ok: true }));
    const metadata: unknown[] = [];
    const options = taskOptions(`run_${_name}`);
    options.store.writeExecutionMetadata = entry => {
      metadata.push(entry);
      return ok(undefined);
    };

    const result = await executeTaskNode(
      inlineTask("exact_input", "async () => ({ ok: true })", { input: authoredInput }),
      {},
      options,
    );

    expect(result.isOk()).toBe(true);
    expect(taskProcessMocks.runTaskAttempt.mock.calls[0]?.[0].request.input).toEqual(expected);
    expect(metadata).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ input: expected }),
      }),
    ]);
  });

  it.each(["root", "array"] as const)("binds an ArtifactRef from %s Task input before starting the process", async shape => {
    taskProcessMocks.runTaskAttempt.mockReturnValue(okAsync({ ok: true }));
    const runId = `run_${shape}_artifact`;
    const artifactId = "artifact_input";
    const uri = `artifact://${runId}/${artifactId}`;
    const workspace = join(taskRuntimeRoot, `${shape}-workspace`);
    mkdirSync(workspace);
    const restoreRuntimeHome = setRuntimeHomeForTest(workspace, join(taskRuntimeRoot, `${shape}-home`));
    try {
      const runsRoot = resolveRuntimeLayout(workspace).runsRoot;
      const path = join(runsRoot, runId, "artifacts", "input.txt");
      mkdirSync(join(runsRoot, runId, "artifacts"), { recursive: true });
      writeFileSync(path, "input\n");
      const artifact: ArtifactRecord = {
        id: artifactId,
        runId,
        nodeKey: "produce",
        attempt: 1,
        digest: "sha256:test",
        size: 6,
        path,
      };
      const artifactExpr = {
        kind: "object",
        fields: {
          kind: { kind: "literal", value: "artifact" },
          uri: { kind: "literal", value: uri },
        },
      } satisfies TaskNodeIR["run"]["input"];
      const input = shape === "root"
        ? artifactExpr
        : { kind: "array" as const, items: [artifactExpr] };
      const options = taskOptions(runId, workspace, runsRoot);
      options.store.getArtifact = (_runId, id) => id === artifactId ? artifact : undefined;

      const result = await executeTaskNode(
        inlineTask(`${shape}_artifact`, "async () => ({ ok: true })", { input }),
        {},
        options,
      );

      expect(result.isOk()).toBe(true);
      expect(taskProcessMocks.runTaskAttempt).toHaveBeenCalledOnce();
      expect(taskProcessMocks.runTaskAttempt.mock.calls[0]?.[0].request.artifact.paths[uri])
        .toMatchObject({ path });
    } finally {
      restoreRuntimeHome();
    }
  });

  it("evaluates the complete Task input expression exactly once", async () => {
    taskProcessMocks.runTaskAttempt.mockReturnValue(okAsync({ ok: true }));
    let reads = 0;
    const runtimeInput = {};
    Object.defineProperty(runtimeInput, "value", {
      enumerable: true,
      get() {
        reads += 1;
        return "resolved";
      },
    });

    const result = await executeTaskNode(
      inlineTask("single_evaluation", "async () => ({ ok: true })", {
        input: { kind: "ref", path: ["input", "value"] },
      }),
      { input: runtimeInput },
      taskOptions("run_single_evaluation"),
    );

    expect(result.isOk()).toBe(true);
    expect(reads).toBe(1);
    expect(taskProcessMocks.runTaskAttempt.mock.calls[0]?.[0].request.input).toBe("resolved");
  });

  it("rejects an undefined Task input before recording metadata or starting a process", async () => {
    const metadata = vi.fn();
    const options = taskOptions("run_undefined_input");
    options.store.writeExecutionMetadata = metadata;

    const result = await executeTaskNode(
      inlineTask("undefined_input", "async () => ({ ok: true })", {
        input: { kind: "ref", path: ["input", "missing"] },
      }),
      { input: {} },
      options,
    );

    expect(result.isErr() && result.error).toMatchObject({
      type: "resolution",
      error: {
        type: "evaluation",
        field: "Task node 'undefined_input' input",
      },
    });
    expect(metadata).not.toHaveBeenCalled();
    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("rejects a non-durable evaluated Task input before recording metadata or starting a process", async () => {
    const metadata = vi.fn();
    const options = taskOptions("run_non_durable_input");
    options.store.writeExecutionMetadata = metadata;

    const result = await executeTaskNode(
      inlineTask("non_durable_input", "async () => ({ ok: true })", {
        input: { kind: "ref", path: ["input", "value"] },
      }),
      { input: { value: new Date(0) } },
      options,
    );

    expect(result.isErr() && result.error).toMatchObject({
      type: "resolution",
      error: {
        type: "evaluation",
        field: "Task node 'non_durable_input' input",
        message: expect.stringContaining("Task node 'non_durable_input' input is not workflow-admissible"),
      },
    });
    expect(metadata).not.toHaveBeenCalled();
    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("returns a typed resolution failure before starting a Task attempt", async () => {
    const result = await executeTaskNode(inlineTask("bad_cwd", "async () => undefined", {
      cwd: { kind: "literal", value: 42 },
    }), {}, taskOptions("run_bad_cwd"));

    expect(result.isErr() && result.error).toMatchObject({
      type: "resolution",
      error: {
        type: "type",
        field: "Task node 'bad_cwd' cwd",
        expected: "string",
        actual: "number",
      },
    });
    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("passes a distant deadline to the Task attempt without timer overflow", async () => {
    const deadlineAt = new Date(Date.now() + 2_147_483_647 + 60_000).toISOString();
    taskProcessMocks.runTaskAttempt.mockReturnValue(okAsync({ ok: true }));

    const result = await executeTaskNode(
      inlineTask("distant", "async () => ({ ok: true })"),
      {},
      { ...taskOptions("run_distant"), deadlineAt },
    );

    expect(result.isOk() ? result.value : undefined).toEqual({ ok: true });
    expect(taskProcessMocks.runTaskAttempt).toHaveBeenCalledOnce();
    expect(taskProcessMocks.runTaskAttempt.mock.calls[0]?.[0].timeoutMs)
      .toBeGreaterThan(2_147_483_647);
  });

  it("returns timed_out when setup exhausts the deadline before the Task attempt", async () => {
    const startedAt = new Date("2026-07-10T00:00:00.000Z").getTime();
    let now = startedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const options = taskOptions("run_setup_timeout");
    options.store.writeExecutionMetadata = () => {
      now += 100;
      return ok(undefined);
    };

    const result = await executeTaskNode(
      inlineTask("setup_timeout", "async () => ({ ok: true })"),
      {},
      { ...options, deadlineAt: new Date(startedAt + 50).toISOString() },
    );

    expect(result.isErr() && result.error).toMatchObject({ type: "timed_out" });
    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("rejects a malformed persisted deadline before starting the Task attempt", async () => {
    await expect(executeTaskNode(
      inlineTask("bad_deadline", "async () => ({ ok: true })"),
      {},
      { ...taskOptions("run_bad_deadline"), deadlineAt: "not-a-deadline" },
    )).rejects.toBeInstanceOf(Error);

    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });
});

function taskOptions(
  runId: string,
  cwd = process.cwd(),
  runsRoot = taskRuntimeRoot,
): TaskExecutorOptions {
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  return {
    cwd,
    runId,
    attemptId: `attempt_${runId}`,
    attemptNo: 1,
    ownerEpoch: 1,
    store: {
      runsRoot,
      getRunDirectoryToken: () => ({
        runId,
        runsRoot: captureDirectoryIdentity(runsRoot, "Runtime runs root"),
        runDirectory: captureDirectoryIdentity(runDir, `Run directory '${runId}'`),
      }),
      getArtifact: () => undefined,
      registerArtifact: (_input: RegisterArtifactInput) => ok(undefined),
      writeExecutionMetadata: () => ok(undefined),
    },
  };
}
