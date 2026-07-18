import { DatabaseSync } from "node:sqlite";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { loadAgentHostPolicy } from "../src/configuration.js";
import type { HookContext } from "../src/hooks/context.js";
import type { HookRunner } from "../src/hooks/runner.js";
import { advanceRuntimeRun } from "../src/runs/advance-runtime.js";
import { createRuntimeRunScheduler, triggerHooksForCommittedRowsForRun } from "../src/scheduler/runtime-runner.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeRow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

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

  it("does not surface malformed committed hook context to runtime callers", async () => {
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

  it("does not let a throwing hook observer interrupt production scheduling", async () => {
    await withRuntimeWorkspace("hooks-runtime-throwing-observer", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let triggerCount = 0;
      const hooks: HookRunner = {
        trigger() {
          triggerCount += 1;
          throw new Error("observer failed");
        },
        async drain() {},
        activeCount() {
          return 0;
        },
      };
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const execution = createRuntimeRunScheduler({
          cwd: workspace,
          store,
          maxLeafConcurrency: 1,
          agentHostPolicy: loadAgentHostPolicy(process.env),
          hookRunner: hooks,
        }).start({ runId: run.id, ownerId: "owner-a" });

        await expect(execution.result).resolves.toMatchObject({ status: "completed" });
        expect(triggerCount).toBeGreaterThan(0);
        expect(store.getRun(run.id)).toMatchObject({ status: "completed" });
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

  it("checkpoints committed hooks before a long run becomes terminal", async () => {
    await withRuntimeWorkspace("hooks-runtime-long-session-checkpoint", async workspace => {
      const markerPath = join(workspace, "hook-task.started");
      const releasePath = join(workspace, "hook-task.release");
      const prepared = await prepareSyntheticWorkflow(workspace, longHookTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      const hooks = recordingHookRunner();
      try {
        const run = await store.admitRun({ prepared, input: { markerPath, releasePath }, cwd: workspace });
        const advancing = advanceRuntimeRun(workspace, store, run.id, "owner-a", { hookRunner: hooks });

        await waitUntil(async () => {
          const started = await access(markerPath).then(() => true, () => false);
          return started && hooks.events.includes("node.started");
        });
        expect(hooks.events).not.toContain("run.completed");
        expect(store.getRun(run.id)).toMatchObject({ status: "running" });

        await writeFile(releasePath, "release");
        await expect(advancing).resolves.toMatchObject({ status: "completed" });
        expect(hooks.events).toContain("run.completed");
      } finally {
        await writeFile(releasePath, "release").catch(() => undefined);
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
      input: { packageName: input.packageName },
      exec: async ({ input }) => ({ packageName: input.packageName }),
    });
    return { packageName: build.output.packageName };
  });
}

function longHookTaskWorkflow() {
  return defineWorkflow({
    name: "hooks-runtime-long-session-checkpoint",
    inputSchema: z.object({ markerPath: z.string(), releasePath: z.string() }),
  }).build(({ input, step }) => {
    const build = step("build").task({
      input: { markerPath: input.markerPath, releasePath: input.releasePath },
      exec: async ({ input, abortSignal }) => {
        const fs = process.getBuiltinModule("node:fs");
        fs.writeFileSync(input.markerPath, "started");
        await new Promise<void>((resolve, reject) => {
          const poll = setInterval(() => {
            if (!fs.existsSync(input.releasePath)) return;
            clearInterval(poll);
            resolve();
          }, 5);
          abortSignal.addEventListener("abort", () => {
            clearInterval(poll);
            reject(new Error("aborted"));
          }, { once: true });
        });
        return { ok: true };
      },
    });
    return { ok: build.output.ok };
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

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
