import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskExecutionTargetIR, WorkflowIR } from "@acpus/core/ir";
import { tryNormalizeWorkflowInput } from "../src/admission/input.js";
import { getRun } from "../src/runs/use-cases.js";
import { describe, expect, it } from "vitest";
import {
  admitPreparedWorkflowForTest,
  admitSyntheticWorkflow,
  failingPureWorkflow,
  failingTaskWorkflow,
  prepareSyntheticWorkflow,
  preparedWorkflow,
  taskArtifactWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

describe.concurrent("runtime task admission use cases", () => {
  it("projects task and pure execution failures through public run state", async () => {
    await withRuntimeWorkspace("runtime-failed-state", async workspace => {
      const task = await admitSyntheticWorkflow(workspace, failingTaskWorkflow());
      expect(task.status).toBe("failed");
      const taskNode = Result.getOrThrow((await Effect.runPromise(Effect.result(getRun(workspace, task.run.id)))))?.dynamic?.nodeInstances
        .find(node => node.nodeId === "boom");
      expect(taskNode).toMatchObject({ status: "failed" });
      expect(taskNode?.output).toBeUndefined();

      const pure = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(pure.status).toBe("failed");
      const failedFrame = Result.getOrThrow((await Effect.runPromise(Effect.result(getRun(workspace, pure.run.id)))))?.dynamic?.frames
        .find(frame => frame.nodeId === "fail");
      expect(failedFrame).toMatchObject({ status: "failed" });
      expect(failedFrame?.result).toBeUndefined();
    });
  });

  it("fails task attempts for live reusable module load failures", async () => {
    const cases = [
      { name: "missing_module", specifier: "./missing-task.ts", exportName: "run", moduleSource: undefined, message: "Cannot find module" },
      { name: "missing_export", specifier: "./missing-export-task.ts", exportName: "run", moduleSource: "export const other = {};\n", message: "is not an Acpus task" },
      { name: "non_task_export", specifier: "./non-task-export-task.ts", exportName: "run", moduleSource: "export const run = {};\n", message: "is not an Acpus task" },
    ];

    await Promise.all(cases.map(item =>
      withRuntimeWorkspace(`runtime-live-module-load-failure-${item.name}`, async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, taskArtifactWorkflow(), `${item.name}.workflow.ts`);
        if (item.moduleSource !== undefined) await writeFile(join(workspace, item.specifier.slice(2)), item.moduleSource);
        setSingleTaskTarget(prepared.ir, {
          kind: "module",
          specifier: item.specifier,
          exportName: item.exportName,
          referrer: { path: `${item.name}.workflow.ts` },
        });
        const frozen = preparedWorkflow(prepared.ir, join(workspace, prepared.source.entry), workspace);
        const admitted = await admitPreparedWorkflowForTest(workspace, frozen, Result.getOrThrow(tryNormalizeWorkflowInput(frozen.ir, {})));

        expect(admitted.status).toBe("failed");
        if (admitted.status !== "failed") throw new Error("expected failed reusable module load run");
        expect(admitted.message).toContain(item.message);
      }),
    ));
  });

});

function setSingleTaskTarget(ir: WorkflowIR, target: TaskExecutionTargetIR): void {
  const node = ir.root.nodes.find(item => item.kind === "task");
  if (!node || node.kind !== "task") throw new Error("expected task node");
  node.run.target = target;
}
