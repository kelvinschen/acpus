import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, okAsync } from "neverthrow";
import type { TaskNodeIR } from "@acpus/core/ir";
import { executeTaskNode as executeTaskNodeResult } from "../src/execution/task-executor.js";
import type { ArtifactRecord, RegisterArtifactInput } from "../src/store/store.js";
import type { TaskAttemptRunner } from "./support/task-attempt-harness.js";

const taskProcessMocks = vi.hoisted(() => ({
  runTaskAttempt: vi.fn<TaskAttemptRunner>(),
  actualRunTaskAttempt: undefined as TaskAttemptRunner | undefined,
}));

async function executeTaskNode(...args: Parameters<typeof executeTaskNodeResult>) {
  const result = await executeTaskNodeResult(...args);
  if (result.isErr()) throw Object.assign(new Error(result.error.message), { failure: result.error });
  return result.value;
}

vi.mock("../src/execution/task-process.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/execution/task-process.js")>();
  taskProcessMocks.actualRunTaskAttempt = actual.runTaskAttempt;
  return { ...actual, runTaskAttempt: taskProcessMocks.runTaskAttempt };
});

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "acpus-task-executor-"));
  if (!taskProcessMocks.actualRunTaskAttempt) throw new Error("Expected the production Task attempt runner.");
  taskProcessMocks.runTaskAttempt.mockReset().mockImplementation(taskProcessMocks.actualRunTaskAttempt);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

describe("task executor", () => {
  it("returns expression resolution failures without rejecting the execution boundary", async () => {
    const result = await executeTaskNodeResult(inlineTask("bad_cwd", "async () => undefined", {
      cwd: { kind: "literal", value: 42 },
    }), {}, taskOptions("run_bad_cwd"));

    expect(result.isErr() && result.error).toMatchObject({
      type: "resolution",
      error: { type: "type", field: "Task node 'bad_cwd' cwd", expected: "string", actual: "number" },
    });
    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("executes inline task source that contains esbuild name helpers", async () => {
    const metadata: unknown[] = [];
    const node = {
      id: "inline",
      kind: "task",
      run: {
        input: {
          value: { kind: "literal", value: "ok" },
        },
        target: {
          kind: "inline",
          source: `async ({ input }) => {
            const finish = __name((value) => ({ value }), "finish");
            return finish(input.value);
          }`,
        },
      },
    } satisfies TaskNodeIR;

    await expect(executeTaskNode(node, {}, {
      cwd: workspace,
      runId: "run_1",
      attemptId: "attempt_1",
      attemptNo: 1,
      ownerEpoch: 1,
      store: {
        getRunDir: () => ".acpus/.local/runs/run_1",
        getArtifact: () => undefined,
        registerArtifact: () => ok(undefined),
        writeExecutionMetadata: (input: unknown) => metadata.push(input),
      },
    })).resolves.toEqual({ value: "ok" });

    expect(metadata).toEqual([
      expect.objectContaining({
        runId: "run_1",
        kind: "task_attempt",
        metadata: {
          nodeId: "inline",
          nodeKey: "inline",
          attemptNo: 1,
          input: { value: "ok" },
          cwd: workspace,
        },
      }),
    ]);
  });

  it("does not create implicit output or work directories", async () => {
    const runId = "run_plain";
    const runDir = join(workspace, ".acpus", ".local", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await Promise.all([
      writeFile(join(runDir, "workflow.ir.json"), "{}\n"),
      writeFile(join(runDir, "lock.json"), "{}\n"),
    ]);

    await expect(executeTaskNode(
      inlineTask("plain", "async () => ({ ok: true })"),
      {},
      taskOptions(runId),
    )).resolves.toEqual({ ok: true });

    await expect(readdir(runDir).then(entries => entries.sort())).resolves.toEqual(["lock.json", "workflow.ir.json"]);
  });

  it("gives task code, Node APIs, artifacts, env, and $ one live process context", async () => {
    const workDir = join(workspace, "worktree");
    const runDir = join(workspace, ".acpus", ".local", "runs", "run_context");
    await mkdir(join(workDir, "nested"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await Promise.all([
      writeFile(join(runDir, "workflow.ir.json"), "{}\n"),
      writeFile(join(runDir, "lock.json"), "{}\n"),
    ]);
    await writeFile(join(workDir, "marker.txt"), "root-marker\n");
    await writeFile(join(workDir, "nested", "marker.txt"), "nested-marker\n");
    const artifacts: RegisterArtifactInput[] = [];
    const node = inlineTask("context", [
      "async ({ $, env, artifact }) => {",
      "  const fs = await import('node:fs/promises');",
      "  const path = await import('node:path');",
      "  const initialCwd = process.cwd();",
      "  const initialMarker = await fs.readFile('marker.txt', 'utf8');",
      "  const sameEnvObject = env === process.env;",
      "  process.chdir('nested');",
      "  env.RUNTIME_MUTATED = 'yes';",
      "  const shellCwd = (await $`pwd`).stdout.trim();",
      "  const shellEnv = (await $`node -e ${\"process.stdout.write(process.env.RUNTIME_MUTATED ?? '')\"}`).stdout.trim();",
      "  const artifactRef = await artifact.write('marker.txt', await fs.readFile('marker.txt'));",
      "  return { initialCwd, initialMarker, sameEnvObject, shellCwd, shellEnv, resolved: path.resolve('marker.txt'), artifactRef, artifactPath: artifact.path(artifactRef), runEnv: process.env.RUNTIME_TASK_ENV, inheritedPath: Boolean(process.env.PATH) };",
      "}",
    ].join("\n"), {
      cwd: { kind: "literal", value: workDir },
      env: { RUNTIME_TASK_ENV: { kind: "literal", value: "from-run-env" } },
    });

    const output = await executeTaskNode(node, {}, taskOptions("run_context", artifact => artifacts.push(artifact))) as Record<string, unknown>;
    expect(output).toEqual({
      initialCwd: workDir,
      initialMarker: "root-marker\n",
      sameEnvObject: true,
      shellCwd: join(workDir, "nested"),
      shellEnv: "yes",
      resolved: join(workDir, "nested", "marker.txt"),
      artifactRef: expect.objectContaining({ kind: "artifact" }),
      artifactPath: expect.any(String),
      runEnv: "from-run-env",
      inheritedPath: true,
    });
    expect(artifacts).toHaveLength(1);
    await expect(readFile(join(runDir, artifacts[0]!.relativePath), "utf8")).resolves.toBe("nested-marker\n");
    expect(output.artifactPath).toBe(join(runDir, artifacts[0]!.relativePath));
    expect(artifacts[0]!.mediaType).toBeUndefined();
    await expect(readdir(runDir).then(entries => entries.sort())).resolves.toEqual(["artifacts", "lock.json", "workflow.ir.json"]);
  });

  it("resolves bound input artifacts to an absolute path that survives process.chdir", async () => {
    const runId = "run_input_path";
    const artifactId = "artifact_input";
    const runDir = `.acpus/.local/runs/${runId}`;
    const path = join(workspace, runDir, "artifacts", "input.txt");
    await mkdir(join(workspace, runDir, "artifacts"), { recursive: true });
    await writeFile(path, "input\n");
    const ref = { kind: "artifact", uri: `artifact://${runId}/${artifactId}`, mediaType: "text/plain" } as const;
    const artifact: ArtifactRecord = {
      id: artifactId,
      runId,
      nodeKey: "produce",
      attempt: 1,
      mediaType: "text/plain",
      digest: "sha256:test",
      size: 6,
      path,
    };
    const node = inlineTask("consume", [
      "async ({ input, artifact }) => {",
      "  const before = artifact.path(input.file);",
      "  process.chdir('/');",
      "  return { before, after: artifact.path(input.file) };",
      "}",
    ].join("\n"), {
      input: {
        file: {
          kind: "object",
          fields: {
            kind: { kind: "literal", value: ref.kind },
            uri: { kind: "literal", value: ref.uri },
            mediaType: { kind: "literal", value: ref.mediaType },
          },
        },
      },
    });

    await expect(executeTaskNode(node, {}, {
      cwd: workspace,
      runId,
      attemptId: "attempt_input_path",
      attemptNo: 1,
      ownerEpoch: 1,
      store: {
        getRunDir: () => runDir,
        getArtifact: (_runId: string, id: string) => id === artifactId ? artifact : undefined,
        registerArtifact: () => ok(undefined),
        writeExecutionMetadata: () => {},
      },
    })).resolves.toEqual({ before: path, after: path });
  });

  it("rejects unbound and cross-run ArtifactRefs", async () => {
    const unbound = inlineTask("unbound", "async ({ artifact }) => artifact.path({ kind: 'artifact', uri: 'artifact://run_unbound/artifact_1' })");
    await expect(executeTaskNode(unbound, {}, taskOptions("run_unbound"))).rejects.toMatchObject({
      failure: { type: "failed", message: expect.stringContaining("is not available to this Task") },
    });

    taskProcessMocks.runTaskAttempt.mockClear();
    const foreign = inlineTask("foreign", "async () => ({ ok: true })", {
      input: {
        file: {
          kind: "object",
          fields: {
            kind: { kind: "literal", value: "artifact" },
            uri: { kind: "literal", value: "artifact://run_other/artifact_1" },
          },
        },
      },
    });
    await expect(executeTaskNode(foreign, {}, taskOptions("run_current"))).rejects.toMatchObject({
      failure: { type: "resolution", error: { type: "evaluation", field: "Task node 'foreign' input" } },
    });
    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("isolates concurrent task cwd and env values", async () => {
    const left = join(workspace, "left");
    const right = join(workspace, "right");
    await Promise.all([mkdir(left), mkdir(right)]);
    await Promise.all([
      writeFile(join(left, "marker.txt"), "left"),
      writeFile(join(right, "marker.txt"), "right"),
    ]);
    const source = [
      "async () => {",
      "  const fs = await import('node:fs/promises');",
      "  const seen = [];",
      "  for (let index = 0; index < 5; index += 1) {",
      "    await new Promise(resolve => setTimeout(resolve, 10));",
      "    seen.push(`${process.cwd()}|${process.env.ISOLATED}|${await fs.readFile('marker.txt', 'utf8')}`);",
      "  }",
      "  return { seen };",
      "}",
    ].join("\n");

    const [leftOutput, rightOutput] = await Promise.all([
      executeTaskNode(inlineTask("left", source, { cwd: { kind: "literal", value: left }, env: { ISOLATED: { kind: "literal", value: "L" } } }), {}, taskOptions("run_left")),
      executeTaskNode(inlineTask("right", source, { cwd: { kind: "literal", value: right }, env: { ISOLATED: { kind: "literal", value: "R" } } }), {}, taskOptions("run_right")),
    ]) as [{ seen: string[] }, { seen: string[] }];

    expect(new Set(leftOutput.seen)).toEqual(new Set([`${left}|L|left`]));
    expect(new Set(rightOutput.seen)).toEqual(new Set([`${right}|R|right`]));
  });

  it("starts reusable task modules fresh for every attempt", async () => {
    const coreURL = import.meta.resolve("@acpus/core");
    const moduleCwd = join(workspace, "module-cwd");
    await mkdir(moduleCwd);
    await writeFile(join(workspace, "workflow.ts"), "");
    await writeFile(join(workspace, "counter.mjs"), [
      `import { task, z } from ${JSON.stringify(coreURL)};`,
      "let count = 0;",
      "const loadedCwd = process.cwd();",
      "const loadedEnv = process.env.MODULE_ENV;",
      "export const counter = task.define({ inputSchema: z.object({}), exec: async () => ({ count: ++count, loadedCwd, loadedEnv }) });",
    ].join("\n"));
    const node = {
      id: "counter",
      kind: "task",
      run: {
        input: {},
        target: { kind: "module", specifier: "./counter.mjs", exportName: "counter", referrer: { path: "workflow.ts" } },
        cwd: { kind: "literal", value: moduleCwd },
        env: { MODULE_ENV: { kind: "literal", value: "module-env" } },
      },
    } satisfies TaskNodeIR;

    await expect(executeTaskNode(node, {}, taskOptions("run_counter_1"))).resolves.toEqual({ count: 1, loadedCwd: moduleCwd, loadedEnv: "module-env" });
    await expect(executeTaskNode(node, {}, taskOptions("run_counter_2"))).resolves.toEqual({ count: 1, loadedCwd: moduleCwd, loadedEnv: "module-env" });
  });

  it("fails only the attempt when cwd is missing or task code exits", async () => {
    const missing = join(workspace, "missing");
    await expect(executeTaskNode(inlineTask("missing", "async () => ({ ok: true })", {
      cwd: { kind: "literal", value: missing },
    }), {}, taskOptions("run_missing"))).rejects.toMatchObject({
      failure: { type: "failed", message: expect.stringMatching(/missing.*ENOENT|ENOENT.*missing/) },
    });

    await expect(executeTaskNode(inlineTask("exit", "async () => { process.exit(23); }"), {}, taskOptions("run_exit"))).rejects.toMatchObject({
      failure: { type: "failed", message: expect.stringContaining("code 23") },
    });
    await expect(executeTaskNode(inlineTask("after", "async () => ({ alive: true })"), {}, taskOptions("run_after"))).resolves.toEqual({ alive: true });
  });

  it("maps timeout to a typed attempt failure", async () => {
    const timedNode = inlineTask("timed", "async ({ abortSignal }) => { if (!abortSignal.aborted) await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true })); return { late: true }; }");
    await expect(executeTaskNode(timedNode, {}, { ...taskOptions("run_timed"), deadlineAt: new Date(Date.now() + 10).toISOString() })).rejects.toMatchObject({
      failure: { type: "timed_out" },
    });
  });

  it("does not overflow distant task deadlines", async () => {
    const deadlineAt = new Date(Date.now() + 2_147_483_647 + 60_000).toISOString();
    taskProcessMocks.runTaskAttempt.mockReturnValue(okAsync({ ok: true }));

    await expect(executeTaskNode(inlineTask("distant", "async () => ({ ok: true })"), {}, {
      ...taskOptions("run_distant"),
      deadlineAt,
    })).resolves.toEqual({ ok: true });
    expect(taskProcessMocks.runTaskAttempt).toHaveBeenCalledOnce();
    expect(taskProcessMocks.runTaskAttempt.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(2_147_483_647);
  });

  it("does not start the task runner when its deadline expires during setup", async () => {
    const startedAt = new Date("2026-07-10T00:00:00.000Z").getTime();
    let now = startedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const options = taskOptions("run_setup_timeout");
    options.store.writeExecutionMetadata = () => { now += 100; };
    await expect(executeTaskNode(inlineTask("setup_timeout", "async () => ({ ok: true })"), {}, {
      ...options,
      deadlineAt: new Date(startedAt + 50).toISOString(),
    })).rejects.toMatchObject({ failure: { type: "timed_out" } });

    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted deadlines before starting the task runner", async () => {
    await expect(executeTaskNode(inlineTask("bad_deadline", "async () => ({ ok: true })"), {}, {
      ...taskOptions("run_bad_deadline"),
      deadlineAt: "not-a-deadline",
    })).rejects.toThrow("Task node 'bad_deadline' has invalid persisted deadline \"not-a-deadline\".");

    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("hard-stops a task that ignores timeout cancellation", async () => {
    const hanging = inlineTask("hanging", "async () => await new Promise(() => {})");
    await expect(executeTaskNode(hanging, {}, { ...taskOptions("run_hanging"), deadlineAt: new Date(Date.now() + 10).toISOString() })).rejects.toMatchObject({
      failure: { type: "timed_out" },
    });
  });

  it("rejects runtime artifact filesystem failures instead of returning a Task failure", async () => {
    const runId = "run_artifact_filesystem_failure";
    const runDir = join(workspace, ".acpus", ".local", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "artifacts"), "blocks the artifact directory");
    let caught: unknown;

    try {
      await executeTaskNodeResult(
        inlineTask("artifact_filesystem_failure", "async ({ artifact }) => artifact.write('result.txt', 'result')"),
        {},
        taskOptions(runId),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "TaskProcessSystemError",
      message: expect.stringContaining("Task artifact write failed for node 'artifact_filesystem_failure' attempt 1"),
      code: "ENOTDIR",
    });
    expect(caught).not.toHaveProperty("failure");
  });

  it("rejects artifact writes after scheduler cancellation", async () => {
    const controller = new AbortController();
    const artifacts: RegisterArtifactInput[] = [];
    const node = inlineTask("cancel_artifact", [
      "async ({ artifact, abortSignal }) => {",
      "  await artifact.write('before.txt', 'before');",
      "  if (!abortSignal.aborted) await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true }));",
      "  try {",
      "    await artifact.write('after.txt', 'after');",
      "  } catch {",
      "    return { lateWriteRejected: true };",
      "  }",
      "  return { lateWriteRejected: false };",
      "}",
    ].join("\n"));
    const running = executeTaskNode(node, {}, {
      ...taskOptions("run_cancel_artifact", artifact => {
        artifacts.push(artifact);
        controller.abort();
      }),
      signal: controller.signal,
    });

    await expect(running).rejects.toMatchObject({ failure: { type: "cancelled" } });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.relativePath).toContain("before.txt");
    expect(artifacts[0]!.mediaType).toBe("text/plain");
  });

  it("removes an artifact file when the durable attempt fence rejects registration", async () => {
    const node = inlineTask("fenced_artifact", "async ({ artifact }) => artifact.write('late.txt', 'late')");
    const options = taskOptions("run_fenced_artifact");
    options.store.registerArtifact = input => err({
      type: "terminal-attempt",
      attemptId: input.attemptId,
      status: "cancelled",
      message: "attempt is already cancelled",
    });

    await expect(executeTaskNode(node, {}, options)).rejects.toMatchObject({
      failure: { type: "terminal-attempt", message: "attempt is already cancelled" },
    });

    const artifactDir = join(workspace, ".acpus/.local/runs/run_fenced_artifact", "artifacts", "fenced_artifact", "attempt-1");
    await expect(readdir(artifactDir)).resolves.toEqual([]);
  });
});

function inlineTask(id: string, source: string, invocation: Partial<Pick<TaskNodeIR["run"], "input" | "cwd" | "env" | "execution">> = {}): TaskNodeIR {
  return {
    id,
    kind: "task",
    run: {
      input: {},
      target: { kind: "inline", source },
      ...invocation,
    },
  };
}

function taskOptions(runId: string, registerArtifact: (artifact: RegisterArtifactInput) => void = () => {}): Parameters<typeof executeTaskNode>[2] {
  return {
    cwd: workspace,
    runId,
    attemptId: `attempt_${runId}`,
    attemptNo: 1,
    ownerEpoch: 1,
    store: {
      getRunDir: () => `.acpus/.local/runs/${runId}`,
      getArtifact: () => undefined,
      registerArtifact: (input: RegisterArtifactInput) => {
        registerArtifact(input);
        return ok(undefined);
      },
      writeExecutionMetadata: () => {},
    },
  };
}
