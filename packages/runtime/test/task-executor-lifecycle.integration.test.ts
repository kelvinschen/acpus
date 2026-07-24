import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeTaskNode,
  inlineTask,
  withTaskExecutorWorkspace,
} from "./support/task-executor-fixture.js";

describe("task executor lifecycle", () => {
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

  it("maps cooperative timeout cancellation to a typed attempt failure", async () => {
    await withTaskExecutorWorkspace(async ({ taskOptions }) => {
      const timedNode = inlineTask(
        "timed",
        "async ({ abortSignal }) => { if (!abortSignal.aborted) await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true })); return { late: true }; }",
      );

      await expect(executeTaskNode(timedNode, {}, {
        ...taskOptions("run_timed"),
        deadlineAt: new Date(Date.now() + 10).toISOString(),
      })).rejects.toMatchObject({ failure: { type: "timed_out" } });
    });
  });

  it("hard-stops a Task that ignores timeout cancellation", async () => {
    await withTaskExecutorWorkspace(async ({ taskOptions }) => {
      const hanging = inlineTask("hanging", "async () => await new Promise(() => {})");

      await expect(executeTaskNode(hanging, {}, {
        ...taskOptions("run_hanging"),
        deadlineAt: new Date(Date.now() + 10).toISOString(),
      })).rejects.toMatchObject({ failure: { type: "timed_out" } });
    });
  });
});
