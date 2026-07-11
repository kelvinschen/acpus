import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import { describe, expect, it } from "vitest";
import type { HookContext } from "../src/hooks/context.js";
import type { HookRunner } from "../src/hooks/runner.js";
import { advanceRuntimeRun } from "../src/runs/advance-runtime.js";
import { triggerHooksForCommittedRowsForRun } from "../src/scheduler/runtime-runner.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeRow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe("runtime hook integration", () => {
  it("triggers hooks from newly committed rows only", async () => {
    await withRuntimeWorkspace("hooks-runtime-new-rows", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, hookTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      const hooks = recordingHookRunner();
      try {
        const run = await store.admitRun({ prepared, input: { packageName: "runtime" }, cwd: workspace });

        await advanceRuntimeRun(workspace, store, run.id, "owner-a", { hookRunner: hooks });
        expect(hooks.events).toEqual(expect.arrayContaining(["run.started", "run.completed"]));
        expect(hooks.contexts.map(context => context.eventSequence)).toEqual([...hooks.contexts.map(context => context.eventSequence)].sort((left, right) => left - right));
        const triggered = hooks.events.length;

        await advanceRuntimeRun(workspace, store, run.id, "owner-b", { hookRunner: hooks });
        store.getRun(run.id);

        expect(hooks.events).toHaveLength(triggered);
      } finally {
        store.close();
      }
    });
  });

  it("does not surface hook observer failures to runtime callers", async () => {
    await withRuntimeWorkspace("hooks-runtime-non-interfering", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, hookTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      const hooks = recordingHookRunner();
      try {
        const run = await store.admitRun({ prepared, input: { packageName: "runtime" }, cwd: workspace });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const summary = await advanceRuntimeRun(workspace, store, run.id, `owner-${attempt}`);
          if (summary.status === "completed" || summary.status === "failed") break;
        }
        const row = runtimeRow(workspace, "SELECT sequence FROM run_events WHERE run_id = ? AND type = 'instance.completed'", run.id);
        if (!row) throw new Error("expected completed instance event");
        const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
        try {
          db.prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = ?").run("{\"bad\":true}", run.id, Number(row.sequence));
        } finally {
          db.close();
        }

        expect(() => triggerHooksForCommittedRowsForRun({
          cwd: workspace,
          store,
          runId: run.id,
          hookRunner: hooks,
          hookCursor: { sequence: Number(row.sequence) - 1 },
        })).not.toThrow();
        expect(hooks.events).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("builds task hook context from persisted effective input", async () => {
    await withRuntimeWorkspace("hooks-runtime-effective-task-input", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, hookTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      const hooks = recordingHookRunner();
      try {
        const run = await store.admitRun({ prepared, input: { packageName: "runtime" }, cwd: workspace });
        await advanceRuntimeRun(workspace, store, run.id, "owner-a", { hookRunner: hooks });

        expect(hooks.contexts.find(context => context.event === "node.started")?.node).toMatchObject({
          id: "build",
          taskInput: { packageName: "runtime" },
        });
      } finally {
        store.close();
      }
    });
  });
});

function hookTaskWorkflow() {
  return defineWorkflow({
    name: "hooks-runtime-effective-task-input",
    inputSchema: z.object({ packageName: z.string() }),
  }).build(({ input, step }) => {
    const build = step("build").task({
      run: {
        input: { packageName: input.packageName },
        exec: async ({ input }) => ({ packageName: input.packageName }),
      },
    });
    return { packageName: build.output.packageName };
  });
}

function recordingHookRunner(): HookRunner & { events: string[]; contexts: HookContext[] } {
  return {
    events: [],
    contexts: [],
    trigger(event, context) {
      this.events.push(event);
      this.contexts.push(context);
    },
    async drain() {},
    activeCount() {
      return 0;
    },
  };
}
