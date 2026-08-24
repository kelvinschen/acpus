import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeNodeProcessHost } from "@acpus/owned-process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskNodeIR } from "@acpus/core/ir";
import {
  executeTaskNode as executeTaskNodeResult,
  type TaskExecutorOptions,
} from "../../src/execution/task-executor.js";
import { resolveRuntimeLayout, setRuntimeHomeForTest } from "../../src/runtime-layout.js";
import type { RegisterArtifactInput } from "../../src/artifacts/types.js";
import { captureDirectoryIdentity } from "../../src/store/path-fence.js";

export type TaskExecutorFixture = {
  workspace: string;
  runtimeRunDir(runId: string): string;
  taskOptions(
    runId: string,
    registerArtifact?: (artifact: RegisterArtifactInput) => void,
  ): TaskExecutorOptions;
};

export async function withTaskExecutorWorkspace<T>(
  test: (fixture: TaskExecutorFixture) => Promise<T>,
): Promise<T> {
  const [workspace, runtimeHome] = await Promise.all([
    mkdtemp(join(tmpdir(), "acpus-task-executor-")),
    mkdtemp(join(tmpdir(), "acpus-task-executor-home-")),
  ]);
  const restoreRuntimeHome = setRuntimeHomeForTest(workspace, runtimeHome);
  const runtimeRunDir = (runId: string) => join(resolveRuntimeLayout(workspace).runsRoot, runId);

  try {
    return await test({
      workspace,
      runtimeRunDir,
      taskOptions(runId, registerArtifact = () => {}) {
        const runDir = runtimeRunDir(runId);
        mkdirSync(runDir, { recursive: true });
        return {
          cwd: workspace,
          runId,
          attemptId: `attempt_${runId}`,
          attemptNo: 1,
          ownerEpoch: 1,
          processes: makeNodeProcessHost(),
          store: {
            getRunDirectoryToken: () => Effect.succeed({
              runId,
              runsRoot: captureDirectoryIdentity(dirname(runDir), "Runtime runs root"),
              runDirectory: captureDirectoryIdentity(runDir, `Run directory '${runId}'`),
            }),
            registerArtifact: input => Effect.sync(() => {
              registerArtifact(input);
            }),
            writeExecutionMetadata: () => Effect.void,
            resolveArtifactRef: () => Effect.die(new Error("Unexpected ArtifactRef resolution.")),
          },
        };
      },
    });
  } finally {
    restoreRuntimeHome();
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(runtimeHome, { recursive: true, force: true }),
    ]);
  }
}

export async function executeTaskNode(
  ...args: Parameters<typeof executeTaskNodeResult>
) {
  const result = await Effect.runPromise(executeTaskNodeResult(...args));
  if (Result.isFailure(result)) {
    throw Object.assign(new Error(result.failure.message), { failure: result.failure });
  }
  return result.success;
}

export function inlineTask(
  id: string,
  source: string,
  invocation: Partial<Pick<TaskNodeIR["run"], "input" | "cwd" | "env" | "execution">> = {},
): TaskNodeIR {
  return {
    id,
    kind: "task",
    run: {
      input: { kind: "literal", value: null },
      target: { kind: "inline", source },
      ...invocation,
    },
  };
}
