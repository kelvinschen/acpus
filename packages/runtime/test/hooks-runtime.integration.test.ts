import { admitRunForTest } from "./support/runtime-store.js";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { loadAgentHostPolicy } from "../src/configuration.js";
import { dispatchCommittedHooksForRun, type HookContext } from "../src/hooks/dispatch.js";
import type { HookRunner } from "../src/hooks/runner.js";
import { createRuntimeRunScheduler } from "../src/scheduler/runtime-runner.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, runtimeRunDir, runtimeRow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { advanceRuntimeRun } from "./support/scheduler.js";

describe.concurrent("runtime hook integration", () => {
  it("triggers hooks from newly committed rows only", async () => {
    await withRuntimeWorkspace("hooks-runtime-new-rows", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, hookTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      const hooks = recordingHookRunner();
      try {
        const run = await admitRunForTest(store, { prepared, input: { packageName: "runtime" }, cwd: workspace });

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

  it("surfaces malformed committed hook data without advancing the durable cursor", async () => {
    await withRuntimeWorkspace("hooks-runtime-non-interfering", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, hookTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      const hooks = recordingHookRunner();
      try {
        const run = await admitRunForTest(store, { prepared, input: { packageName: "runtime" }, cwd: workspace });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const summary = await advanceRuntimeRun(workspace, store, run.id, `owner-${attempt}`);
          if (summary.status === "completed" || summary.status === "failed") break;
        }
        const row = runtimeRow(workspace, "SELECT sequence FROM run_events WHERE run_id = ? AND type = 'instance.completed'", run.id);
        if (!row) throw new Error("expected completed instance event");
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = ?").run("{\"bad\":true}", run.id, Number(row.sequence));
          db.prepare("UPDATE hook_dispatch_cursors SET event_sequence = ? WHERE run_id = ?").run(Number(row.sequence) - 1, run.id);
        } finally {
          db.close();
        }

        expect(() => dispatchCommittedHooksForRun({
          cwd: workspace,
          store,
          runId: run.id,
          hookRunner: hooks,
        })).toThrow();
        expect(store.getHookDispatchCursor(run.id)).toBe(Number(row.sequence) - 1);
        expect(hooks.events).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("rejects a hook cursor ahead of the event log before daemon idle accounting", async () => {
    await withRuntimeWorkspace("hooks-runtime-cursor-ahead", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const lastSequence = store.getLastRunEventSequence(run.id);
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare("UPDATE hook_dispatch_cursors SET event_sequence = ? WHERE run_id = ?").run(lastSequence + 1, run.id);
        } finally {
          db.close();
        }

        expect(() => store.listRuntimeWork()).toThrow(
          `hook dispatch cursor ${lastSequence + 1} exceeds committed event sequence ${lastSequence}`,
        );
      } finally {
        store.close();
      }
    });
  });

  it("rejects a tampered Agent prompt artifact without advancing the durable cursor", async () => {
    await withRuntimeWorkspace("hooks-runtime-tampered-agent-prompt", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, hookTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      const hooks = recordingHookRunner();
      try {
        const run = await admitRunForTest(store, { prepared, input: { packageName: "runtime" }, cwd: workspace });
        await expect(advanceRuntimeRun(workspace, store, run.id, "owner-a")).resolves.toMatchObject({ status: "completed" });
        const completed = runtimeRow(
          workspace,
          "SELECT sequence, json_extract(payload_json, '$.payload.attemptId') AS attempt_id, json_extract(payload_json, '$.payload.nodeKey') AS node_key FROM run_events WHERE run_id = ? AND type = 'instance.completed'",
          run.id,
        ) as { sequence: number; attempt_id: string; node_key: string } | undefined;
        if (!completed?.attempt_id) throw new Error("expected attempt-backed completion event");

        const artifactId = "hook-agent-turn";
        const relativePath = "artifacts/hook-agent-turn.json";
        const original = Buffer.from('{"prompt":"original"}');
        const artifactPath = join(runtimeRunDir(workspace, run.id), relativePath);
        await mkdir(join(artifactPath, ".."), { recursive: true });
        await writeFile(artifactPath, original);
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare(`
            INSERT INTO artifacts (id, run_id, node_key, attempt, media_type, digest, size, relative_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            artifactId,
            run.id,
            completed.node_key,
            1,
            "application/json",
            `sha256:${createHash("sha256").update(original).digest("hex")}`,
            original.byteLength,
            relativePath,
            new Date().toISOString(),
          );
          db.prepare("UPDATE hook_dispatch_cursors SET event_sequence = ? WHERE run_id = ?").run(completed.sequence - 1, run.id);
        } finally {
          db.close();
        }
        store.writeExecutionMetadata({
          runId: run.id,
          attemptId: completed.attempt_id,
          kind: "agent_attempt",
          metadata: { turns: [{ turnArtifact: { artifactId, mediaType: "application/json" } }] },
        });
        await writeFile(artifactPath, '{"prompt":"tampered"}');

        expect(() => dispatchCommittedHooksForRun({ cwd: workspace, store, runId: run.id, hookRunner: hooks })).toThrow("size/digest verification");
        expect(store.getHookDispatchCursor(run.id)).toBe(completed.sequence - 1);
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
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const execution = createRuntimeRunScheduler({
          cwd: workspace,
          store,
          maxLeafConcurrency: 1,
          agentHostPolicy: loadAgentHostPolicy(process.env),
          hookRunner: hooks,
        }).start({ runId: run.id, ownerId: "owner-a" });

        expect((await execution.result)._unsafeUnwrap()).toMatchObject({ status: "completed" });
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
        const run = await admitRunForTest(store, { prepared, input: { packageName: "runtime" }, cwd: workspace });
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
        const run = await admitRunForTest(store, { prepared, input: { markerPath, releasePath }, cwd: workspace });
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
