import { basename, dirname, join } from "node:path";
import { access, watch } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SchedulerStoreException } from "../src/scheduler/store-port.js";
import {
  executeTaskNode,
  inlineTask,
  withTaskExecutorWorkspace,
} from "./support/task-executor-fixture.js";

describe("task executor lifecycle", () => {
  it("rejects a fenced metadata write before starting the Task process", async () => {
    await withTaskExecutorWorkspace(async ({ taskOptions }) => {
      const options = taskOptions("run_metadata_fenced");
      options.store.writeExecutionMetadata = input => {
        throw new SchedulerStoreException({
          type: "owner-epoch-inactive",
          runId: input.runId,
          ownerEpoch: input.ownerEpoch,
          message: "metadata owner expired",
        });
      };

      await expect(executeTaskNode(
        inlineTask("metadata_fenced", "async () => ({ shouldNotRun: true })"),
        {},
        options,
      )).rejects.toMatchObject({
        failure: {
          type: "owner-epoch-inactive",
          runId: "run_metadata_fenced",
          ownerEpoch: 1,
        },
      });
    });
  });

  it("confines missing cwd and process exit failures to their Task attempts", async () => {
    await withTaskExecutorWorkspace(async ({ workspace, taskOptions }) => {
      const missing = join(workspace, "missing");
      await expect(executeTaskNode(
        inlineTask("missing", "async () => ({ ok: true })", {
          cwd: { kind: "literal", value: missing },
        }),
        {},
        taskOptions("run_missing"),
      )).rejects.toMatchObject({ failure: { type: "failed" } });

      await expect(executeTaskNode(
        inlineTask("exit", "async () => { process.exit(23); }"),
        {},
        taskOptions("run_exit"),
      )).rejects.toMatchObject({ failure: { type: "failed" } });
      await expect(executeTaskNode(
        inlineTask("after", "async () => ({ alive: true })"),
        {},
        taskOptions("run_after"),
      )).resolves.toEqual({ alive: true });
    });
  });

  it("bridges caller cancellation to a running Task AbortSignal", async () => {
    await withTaskExecutorWorkspace(async ({ workspace, taskOptions }) => {
      const readyPath = join(workspace, "task-ready");
      const abortedPath = join(workspace, "task-aborted");
      const cancellable = inlineTask(
        "cancellable",
        `async ({ abortSignal }) => {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(${JSON.stringify(readyPath)}, "ready");
          if (!abortSignal.aborted) await new Promise(resolve => abortSignal.addEventListener("abort", resolve, { once: true }));
          await writeFile(${JSON.stringify(abortedPath)}, "aborted");
          return { late: true };
        }`,
      );
      const controller = new AbortController();
      const settled = executeTaskNode(cancellable, {}, {
        ...taskOptions("run_cancelled"),
        signal: controller.signal,
      }).then(
        value => ({ success: true as const, value }),
        failure => ({ success: false as const, failure }),
      );
      const readyWait = new AbortController();

      try {
        const first = await Promise.race([
          waitForPath(readyPath, readyWait.signal).then(() => ({ type: "ready" as const })),
          settled.then(outcome => ({ type: "settled" as const, outcome })),
        ]);
        if (first.type === "settled") {
          throw new Error(`Task settled before publishing its ready marker: ${JSON.stringify(first.outcome)}`);
        }
        controller.abort();
        expect(await settled).toMatchObject({ success: false, failure: { failure: { type: "cancelled" } } });
        await expect(access(abortedPath)).resolves.toBeUndefined();
      } finally {
        readyWait.abort();
        controller.abort();
        await settled;
      }
    });
  });
});

async function waitForPath(path: string, signal: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(10_000);
  const watched = watch(dirname(path), { signal: AbortSignal.any([signal, timeout]) });
  try {
    try {
      await access(path);
      return;
    } catch {}
    for await (const event of watched) {
      if (event.filename !== basename(path)) continue;
      try {
        await access(path);
        return;
      } catch {}
    }
  } catch (error) {
    if (!timeout.aborted) throw error;
    throw new Error(`Timed out waiting for ${path}.`);
  }
}
