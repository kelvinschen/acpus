import { defineWorkflow } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { addAgentPreset, applyAgentPresetChanges } from "../src/index.js";
import { openRuntimeStore } from "../src/store/store.js";
import { getRunVisualizationSnapshot } from "../src/runs/use-cases.js";
import { prepareSyntheticWorkflow, runtimeRows, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { advanceRuntimeRun } from "./support/scheduler.js";

describe("Agent Preset admission and fork freezing", () => {
  it("expands a project preset at admission and replays a request without rereading changed catalog state", async () => {
    await withRuntimeWorkspace("runtime-agent-preset-admission", async workspace => {
      await setProjectPreset(workspace, "first-agent", "first-secret");
      const prepared = await prepareSyntheticWorkflow(workspace, slotWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const first = (await store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          requestId: "preset-admission",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))._unsafeUnwrap();
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

        await setProjectPreset(workspace, "second-agent", "second-secret");
        const replay = (await store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          requestId: "preset-admission",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))._unsafeUnwrap();
        const fresh = (await store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          requestId: "preset-admission-fresh",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))._unsafeUnwrap();

        expect(replay.id).toBe(first.id);
        expect(store.getFrozenRun(replay.id)?.ir.agents.reviewer).toMatchObject({ use: "first-agent" });
        expect(fresh.id).not.toBe(first.id);
        expect(store.getFrozenRun(fresh.id)?.ir.agents.reviewer).toMatchObject({ use: "second-agent" });
      } finally {
        store.close();
      }
    });
  });

  it("re-resolves an explicit fork preset but replays the same request from frozen state", async () => {
    await withRuntimeWorkspace("runtime-agent-preset-fork", async workspace => {
      await setProjectPreset(workspace, "source-agent", "source-secret");
      const prepared = await prepareSyntheticWorkflow(workspace, slotWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const source = (await store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))._unsafeUnwrap();
        await setProjectPreset(workspace, "fork-agent", "fork-secret");
        const first = (await store.forkRun(source.id, {
          requestId: "preset-fork",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))._unsafeUnwrap();
        expect(store.getFrozenRun(first.id)?.ir.agents.reviewer).toMatchObject({
          use: "fork-agent",
          config: { secret: "fork-secret" },
        });

        await setProjectPreset(workspace, "changed-after-fork", "changed-secret");
        const replay = (await store.forkRun(source.id, {
          requestId: "preset-fork",
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))._unsafeUnwrap();
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
      const store = await openRuntimeStore(workspace);
      try {
        const source = (await store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          agentInjections: { reviewer: { preset: "reviewer" } },
        }))._unsafeUnwrap();
        const child = (await store.forkRun(source.id, {
          agentInjections: {
            reviewer: {
              model: "fork-model",
              config: { secret: "fork-secret" },
              env: { FORK: "yes" },
            },
          },
        }))._unsafeUnwrap();

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
        expect((await getRunVisualizationSnapshot(workspace, child.id))._unsafeUnwrap()).toMatchObject({
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
      const store = await openRuntimeStore(workspace);
      try {
        const beforeAdmission = store.listWorkflowSources();
        expect((await store.admitRun({ prepared: slotPrepared, input: {}, cwd: workspace }))._unsafeUnwrapErr()).toEqual({
          type: "agent-bindings-unresolved",
          agentNames: ["reviewer"],
          message: "Agent bindings are required for: reviewer.",
        });
        expect(store.listWorkflowSources()).toEqual(beforeAdmission);

        const concretePrepared = await prepareSyntheticWorkflow(workspace, validWorkflow(), "concrete.workflow.ts");
        const source = (await store.admitRun({
          prepared: concretePrepared,
          input: { ready: true },
          cwd: workspace,
        }))._unsafeUnwrap();
        const beforeFork = store.listWorkflowSources();
        expect((await store.forkRun(source.id, { prepared: slotPrepared }))._unsafeUnwrapErr()).toMatchObject({
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
  const added = await addAgentPreset({ workspaceDir, scope: "project", id: "reviewer", preset });
  if (added.isOk()) return;
  if (added.error.type !== "agent-preset-exists") throw new Error(added.error.message);
  (await applyAgentPresetChanges({
    workspaceDir,
    scope: "project",
    changes: [{ type: "set", id: "reviewer", preset }],
  }))._unsafeUnwrap();
}
