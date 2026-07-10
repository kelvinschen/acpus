import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskNodeIR } from "@acpus/core/ir";
import { executeTaskNode } from "../src/execution/task-executor.js";
import type { TaskAttemptRunner } from "../src/execution/task-process.js";
import type { RegisterArtifactInput, RuntimeStore } from "../src/store/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "acpus-task-executor-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

describe("task executor", () => {
  it("executes inline task source that contains esbuild name helpers", async () => {
    const metadata: unknown[] = [];
    const node = {
      id: "inline",
      kind: "task",
      run: {
        kind: "task_run",
        input: {
          value: { kind: "literal", value: "ok" },
        },
        target: {
          kind: "inline",
          runtime: "node",
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
      store: {
        getRunDir: () => ".acpus/.local/runs/run_1",
        registerArtifact: () => {},
        writeExecutionMetadata: (input: unknown) => metadata.push(input),
      } as unknown as RuntimeStore,
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

  it("gives task code, Node APIs, artifacts, env, and $ one live process context", async () => {
    const workDir = join(workspace, "worktree");
    await mkdir(join(workDir, "nested"), { recursive: true });
    await writeFile(join(workDir, "marker.txt"), "root-marker\n");
    await writeFile(join(workDir, "nested", "marker.txt"), "nested-marker\n");
    const artifacts: Array<{ relativePath: string }> = [];
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
      "  const artifactRef = await artifact.fromFile('marker.txt');",
      "  return { initialCwd, initialMarker, sameEnvObject, shellCwd, shellEnv, resolved: path.resolve('marker.txt'), artifactRef, runEnv: process.env.RUNTIME_TASK_ENV, inheritedPath: Boolean(process.env.PATH) };",
      "}",
    ].join("\n"), {
      cwd: { kind: "literal", value: workDir },
      env: { RUNTIME_TASK_ENV: { kind: "literal", value: "from-run-env" } },
    });

    await expect(executeTaskNode(node, {}, taskOptions("run_context", artifact => artifacts.push(artifact)))).resolves.toEqual({
      initialCwd: workDir,
      initialMarker: "root-marker\n",
      sameEnvObject: true,
      shellCwd: join(workDir, "nested"),
      shellEnv: "yes",
      resolved: join(workDir, "nested", "marker.txt"),
      artifactRef: expect.objectContaining({ kind: "artifact" }),
      runEnv: "from-run-env",
      inheritedPath: true,
    });
    expect(artifacts).toHaveLength(1);
    await expect(readFile(join(workspace, ".acpus/.local/runs/run_context", artifacts[0]!.relativePath), "utf8")).resolves.toBe("nested-marker\n");
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
        kind: "task_run",
        input: {},
        target: { kind: "module", runtime: "node", specifier: "./counter.mjs", exportName: "counter", referrer: { kind: "workflow", path: "workflow.ts" } },
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
      failure: { type: "spawn", cwd: missing, code: "ENOENT" },
    });

    await expect(executeTaskNode(inlineTask("exit", "async () => { process.exit(23); }"), {}, taskOptions("run_exit"))).rejects.toMatchObject({
      failure: { type: "unexpected_exit", exitCode: 23 },
    });
    await expect(executeTaskNode(inlineTask("after", "async () => ({ alive: true })"), {}, taskOptions("run_after"))).resolves.toEqual({ alive: true });
  });

  it("maps timeout and scheduler abort to typed attempt failures", async () => {
    const timedNode = inlineTask("timed", "async ({ abortSignal }) => { if (!abortSignal.aborted) await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true })); return { late: true }; }");
    await expect(executeTaskNode(timedNode, {}, { ...taskOptions("run_timed"), deadlineAt: new Date(Date.now() + 10).toISOString() })).rejects.toMatchObject({
      failure: { type: "timed_out" },
    });

    const controller = new AbortController();
    controller.abort();
    await expect(executeTaskNode(inlineTask("cancelled", "async ({ abortSignal }) => ({ aborted: abortSignal.aborted })"), {}, {
      ...taskOptions("run_cancelled"),
      signal: controller.signal,
    })).rejects.toMatchObject({ failure: { type: "cancelled" } });
  });

  it("does not overflow distant task deadlines", async () => {
    const deadlineAt = new Date(Date.now() + 2_147_483_647 + 60_000).toISOString();

    await expect(executeTaskNode(inlineTask("distant", "async () => ({ ok: true })"), {}, {
      ...taskOptions("run_distant"),
      deadlineAt,
    })).resolves.toEqual({ ok: true });
  });

  it("does not start the task runner when its deadline expires during setup", async () => {
    const startedAt = new Date("2026-07-10T00:00:00.000Z").getTime();
    let now = startedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const options = taskOptions("run_setup_timeout");
    options.store.writeExecutionMetadata = () => { now += 100; };
    const taskAttemptRunner = vi.fn<TaskAttemptRunner>(() => okAsync({ ok: true }));

    await expect(executeTaskNode(inlineTask("setup_timeout", "async () => ({ ok: true })"), {}, {
      ...options,
      deadlineAt: new Date(startedAt + 50).toISOString(),
      taskAttemptRunner,
    })).rejects.toMatchObject({ failure: { type: "timed_out" } });

    expect(taskAttemptRunner).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted deadlines before starting the task runner", async () => {
    const taskAttemptRunner = vi.fn<TaskAttemptRunner>(() => okAsync({ ok: true }));

    await expect(executeTaskNode(inlineTask("bad_deadline", "async () => ({ ok: true })"), {}, {
      ...taskOptions("run_bad_deadline"),
      deadlineAt: "not-a-deadline",
      taskAttemptRunner,
    })).rejects.toThrow("Task node 'bad_deadline' has invalid persisted deadline \"not-a-deadline\".");

    expect(taskAttemptRunner).not.toHaveBeenCalled();
  });

  it("hard-stops a task that ignores timeout cancellation", async () => {
    const hanging = inlineTask("hanging", "async () => await new Promise(() => {})");
    await expect(executeTaskNode(hanging, {}, { ...taskOptions("run_hanging"), deadlineAt: new Date(Date.now() + 10).toISOString() })).rejects.toMatchObject({
      failure: { type: "timed_out" },
    });
  });

  it("rejects artifact writes after scheduler cancellation", async () => {
    const controller = new AbortController();
    const artifacts: RegisterArtifactInput[] = [];
    const node = inlineTask("cancel_artifact", [
      "async ({ artifact, abortSignal }) => {",
      "  await artifact.writeText('before.txt', 'before');",
      "  if (!abortSignal.aborted) await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true }));",
      "  try {",
      "    await artifact.writeText('after.txt', 'after');",
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
  });
});

function inlineTask(id: string, source: string, invocation: Pick<TaskNodeIR["run"], "cwd" | "env" | "execution"> = {}): TaskNodeIR {
  return {
    id,
    kind: "task",
    run: {
      kind: "task_run",
      input: {},
      target: { kind: "inline", runtime: "node", source },
      ...invocation,
    },
  };
}

function taskOptions(runId: string, registerArtifact: (artifact: RegisterArtifactInput) => void = () => {}): Parameters<typeof executeTaskNode>[2] {
  return {
    cwd: workspace,
    runId,
    store: {
      getRunDir: () => `.acpus/.local/runs/${runId}`,
      registerArtifact,
      writeExecutionMetadata: () => {},
    } as unknown as RuntimeStore,
  };
}
