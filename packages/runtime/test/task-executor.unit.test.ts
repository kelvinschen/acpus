import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskNodeIR } from "@acpus/core/ir";
import { executeTaskNode } from "../src/execution/task-executor.js";
import type { RuntimeStore } from "../src/store/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "acpus-task-executor-"));
});

afterEach(async () => {
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
});
