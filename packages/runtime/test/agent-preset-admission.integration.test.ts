import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { defineWorkflow } from "@acpus/core";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAgentPreset, applyAgentPresetChanges } from "../src/index.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { openRuntimeStoreAdapter, openRuntimeStoreAdapterAtLayout } from "../src/store/store.js";
import { getRunVisualizationSnapshot } from "../src/runs/use-cases.js";
import { settle } from "./effect.js";
import {
  initializeRuntimeStoreForTest,
  prepareSyntheticWorkflow,
  runtimeRows,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { advanceRuntimeRun } from "./support/scheduler.js";

describe("Agent Preset admission and fork freezing", () => {
  it("expands a project preset at admission and replays a request without rereading changed catalog state", async () => {
    await withRuntimeWorkspace("runtime-agent-preset-admission", async workspace => {
      await setProjectPreset(workspace, "first-agent", "first-secret");
      const prepared = await prepareSyntheticWorkflow(workspace, slotWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const first = Result.getOrThrow((await settle(store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          requestId: "preset-admission",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))));
        expect(store.getFrozenRun(first.id)).toMatchObject({
          ir: { agents: { reviewer: { kind: "agent_definition", use: "first-agent", config: { secret: "first-secret" } } } },
          agentBindings: {
            reviewer: {
              source: { kind: "preset", id: "reviewer", scope: "project" },
              injection: { use: "first-agent", config: { secret: "first-secret" } },
            },
          },
        });
        expect(store.getRun(first.id)).not.toHaveProperty("agentBindings");

        await writeFile(join(workspace, ".acpus", "config.json"), "{ invalid catalog\n");
        const replay = Result.getOrThrow((await settle(store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          requestId: "preset-admission",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))));
        const fresh = await settle(store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          requestId: "preset-admission-fresh",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }));

        expect(replay.id).toBe(first.id);
        expect(store.getFrozenRun(replay.id)?.ir.agents.reviewer).toMatchObject({ use: "first-agent" });
        expect(Result.isFailure(fresh) ? fresh.failure : undefined).toMatchObject({ type: "acpus-config-invalid" });
        expect(runtimeRows(workspace, "SELECT run_id FROM run_events WHERE type = 'run.admitted'")).toHaveLength(1);
      } finally {
        store.close();
      }
    });
  });

  it("replays a Host preset admission without invoking its provider again", async () => {
    await withRuntimeWorkspace("runtime-host-preset-replay", async workspace => {
      await initializeRuntimeStoreForTest(workspace);
      const prepared = await prepareSyntheticWorkflow(workspace, slotWorkflow());
      let providerCalls = 0;
      const store = await openRuntimeStoreAdapterAtLayout(resolveRuntimeLayout(workspace), {
        agentPresetProvider: () => Effect.suspend(() => {
          providerCalls += 1;
          return providerCalls === 1
            ? Effect.succeed([{ id: "reviewer", guidance: "Review", agent: { use: "host-agent" } }])
            : Effect.fail({
                type: "agent-preset-provider-failed" as const,
                message: "provider must not be called for replay",
              });
        }),
      });
      try {
        const input = {
          prepared,
          input: {},
          cwd: workspace,
          requestId: "host-preset-replay",
          agentInjections: { reviewer: { preset: "reviewer" } },
        } as const;
        const first = Result.getOrThrow((await settle(store.admitRun(input))));
        const replay = Result.getOrThrow((await settle(store.admitRun(input))));

        expect(replay.id).toBe(first.id);
        expect(providerCalls).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("does not publish a Run when Host preset resolution is interrupted", async () => {
    await withRuntimeWorkspace("runtime-host-preset-interruption", async workspace => {
      await initializeRuntimeStoreForTest(workspace);
      const prepared = await prepareSyntheticWorkflow(workspace, slotWorkflow());
      const providerStarted = Deferred.makeUnsafe<void>();
      const providerInterrupted = Deferred.makeUnsafe<void>();
      const store = await openRuntimeStoreAdapterAtLayout(resolveRuntimeLayout(workspace), {
        agentPresetProvider: () => Effect.gen(function*() {
          Deferred.doneUnsafe(providerStarted, Effect.void);
          yield* Effect.never;
          return [];
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => {
          Deferred.doneUnsafe(providerInterrupted, Effect.void);
        }))),
      });
      try {
        const fiber = Effect.runFork(store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          requestId: "host-preset-interrupted",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }));
        await Effect.runPromise(Deferred.await(providerStarted));
        await Effect.runPromise(Fiber.interrupt(fiber));
        await Effect.runPromise(Deferred.await(providerInterrupted));

        expect(store.listRuns()).toEqual([]);
        expect(runtimeRows(workspace, "SELECT run_id FROM run_events WHERE type = 'run.admitted'"))
          .toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("re-resolves an explicit fork preset but replays the same request from frozen state", async () => {
    await withRuntimeWorkspace("runtime-agent-preset-fork", async workspace => {
      await setProjectPreset(workspace, "source-agent", "source-secret");
      const prepared = await prepareSyntheticWorkflow(workspace, slotWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const source = Result.getOrThrow((await settle(store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))));
        await setProjectPreset(workspace, "fork-agent", "fork-secret");
        const first = Result.getOrThrow((await settle(store.forkRun(source.id, {
          requestId: "preset-fork",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))));
        expect(store.getFrozenRun(first.id)?.ir.agents.reviewer).toMatchObject({
          use: "fork-agent",
          config: { secret: "fork-secret" },
        });

        await setProjectPreset(workspace, "changed-after-fork", "changed-secret");
        const replay = Result.getOrThrow((await settle(store.forkRun(source.id, {
          requestId: "preset-fork",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))));
        expect(replay).toMatchObject({ id: first.id, forkCreated: false });
        expect(store.getFrozenRun(replay.id)?.ir.agents.reviewer).toMatchObject({ use: "fork-agent" });

        const event = runtimeRows(
          workspace,
          "SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'run.forked'",
          first.id,
        )[0] as { payload_json: string };
        expect(event.payload_json).not.toContain("fork-agent");
        expect(event.payload_json).not.toContain("fork-secret");
        expect(JSON.parse(event.payload_json)).toMatchObject({
          requestFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          semanticFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });
      } finally {
        store.close();
      }
    });
  });

  it("keeps a field-overridden Preset fork readable for execution and visualization", async () => {
    await withRuntimeWorkspace("runtime-agent-preset-field-fork", async workspace => {
      await setProjectPreset(workspace, "source-agent", "source-secret");
      const prepared = await prepareSyntheticWorkflow(workspace, slotWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const source = Result.getOrThrow((await settle(store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))));
        const child = Result.getOrThrow((await settle(store.forkRun(source.id, {
          agentInjections: {
            reviewer: {
              model: "fork-model",
              config: { secret: "fork-secret" },
              env: { FORK: "yes" },
            },
          },
        }))));

        expect(store.getFrozenRun(child.id)).toMatchObject({
          ir: {
            agents: {
              reviewer: {
                kind: "agent_definition",
                use: "source-agent",
                model: "fork-model",
                config: { secret: "fork-secret" },
                env: { FORK: "yes" },
              },
            },
          },
          agentBindings: {
            reviewer: {
              source: { kind: "preset", id: "reviewer", scope: "project" },
            },
          },
        });
        expect(Result.getOrThrow((await Effect.runPromise(Effect.result(getRunVisualizationSnapshot(workspace, child.id)))))).toMatchObject({
          workflow: {
            agents: {
              reviewer: { use: "source-agent", model: "fork-model", config: { secret: "fork-secret" } },
            },
          },
        });
        await expect(advanceRuntimeRun(workspace, store, child.id, "fork-owner"))
          .resolves.toMatchObject({ status: "completed" });
      } finally {
        store.close();
      }
    });
  });

  it("rejects unresolved slots before publishing admission or replacement workflow source", async () => {
    await withRuntimeWorkspace("runtime-agent-slot-publication", async workspace => {
      const slotPrepared = await prepareSyntheticWorkflow(workspace, slotWorkflow(), "slot.workflow.ts");
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const beforeAdmission = store.listWorkflowSources();
        expect(Result.getOrThrow(Result.flip((await settle(store.admitRun({ prepared: slotPrepared, input: {}, cwd: workspace })))))).toEqual({
          type: "agent-bindings-unresolved",
          agentNames: ["reviewer"],
          message: "Agent bindings are required for: reviewer.",
        });
        expect(store.listWorkflowSources()).toEqual(beforeAdmission);

        const concretePrepared = await prepareSyntheticWorkflow(workspace, validWorkflow(), "concrete.workflow.ts");
        const source = Result.getOrThrow((await settle(store.admitRun({
          prepared: concretePrepared,
          input: { ready: true },
          cwd: workspace,
        }))));
        const beforeFork = store.listWorkflowSources();
        expect(Result.getOrThrow(Result.flip((await settle(store.forkRun(source.id, { prepared: slotPrepared })))))).toMatchObject({
          type: "agent-bindings-unresolved",
          agentNames: ["reviewer"],
        });
        expect(store.listWorkflowSources()).toEqual(beforeFork);
      } finally {
        store.close();
      }
    });
  });
});

function slotWorkflow() {
  return defineWorkflow({
    name: "runtime-agent-preset-slot",
    agents: { reviewer: { model: "slot-default" } },
  }).build(() => ({}));
}

async function setProjectPreset(workspaceDir: string, use: string, secret: string): Promise<void> {
  const preset = {
    guidance: "Review changes",
    agent: { use, config: { secret } },
  };
  const added = await Effect.runPromise(Effect.result(addAgentPreset({ workspaceDir, scope: "project", id: "reviewer", preset })));
  if (Result.isSuccess(added)) return;
  if (added.failure.type !== "agent-preset-exists") throw new Error(added.failure.message);
  Result.getOrThrow((await Effect.runPromise(Effect.result(applyAgentPresetChanges({
    workspaceDir,
    scope: "project",
    changes: [{ type: "set", id: "reviewer", preset }],
  })))));
}
