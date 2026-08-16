import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkflow } from "@acpus/core";
import type { Result } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

const lifecycleInspector = vi.hoisted(() => vi.fn(() => {
  throw new Error("daemon submission observation must not run lifecycle inspection");
}));

vi.mock("../src/runtime-store-lifecycle.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runtime-store-lifecycle.js")>(),
  inspectRuntimeStore: lifecycleInspector,
}));

import { requestDaemonStatus, requestDaemonSubmitAndObserve } from "../src/daemon/client.js";
import { startDaemonLoop } from "../src/daemon/loop.js";
import type { DaemonRunStreamClientFailure, DaemonRunStreamFrame } from "../src/daemon/protocol.js";
import { inspectAgentExecution } from "../src/inspection/use-cases.js";
import {
  initializeRuntimeStoreForTest,
  prepareSyntheticWorkflow,
  runtimeDatabasePath,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

const fixtureAgent = fileURLToPath(new URL("./fixtures/wal-usage-acp-agent.mjs", import.meta.url));
const realSetTimeout = globalThis.setTimeout;

function acceleratedObservationTimeout<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delay?: number,
  ...args: TArgs
): NodeJS.Timeout {
  return realSetTimeout(callback, delay === 1_000 ? 10 : delay, ...args);
}

describe("daemon WAL-backed observation", () => {
  it("streams committed progress and closes while an independent reader sees Agent usage", async () => {
    await withRuntimeWorkspace("daemon-wal-observation", async workspace => {
      const agentReady = join(workspace, "agent.ready");
      const agentRelease = join(workspace, "agent.release");
      const taskReady = join(workspace, "task.ready");
      const taskRelease = join(workspace, "task.release");
      const prepared = await prepareSyntheticWorkflow(
        workspace,
        walProgressWorkflow({ agentReady, agentRelease, taskReady, taskRelease }),
      );
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 10,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      let observationTimer: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const status = await requestDaemonStatus(workspace);
        if (status.isErr()) throw new Error(status.error.message);
        observationTimer = vi.spyOn(globalThis, "setTimeout").mockImplementation(acceleratedObservationTimeout);
        const iterator = requestDaemonSubmitAndObserve(workspace, {
          expectedAuthority: status.value.authority,
          requestId: "daemon-wal-observation",
          prepared,
          input: {},
          until: "subject-terminal",
        })[Symbol.asyncIterator]();

        const admitted = frame(await iterator.next());
        expect(admitted).toMatchObject({ kind: "admitted", run: { id: expect.any(String) } });
        if (admitted.kind !== "admitted") throw new Error("Expected daemon admission.");
        const attached = frame(await iterator.next());
        expect(attached).toMatchObject({
          kind: "observation",
          observation: { kind: "attached" },
        });

        await waitUntilReal(async () => fileExists(agentReady));
        await expect(access(`${runtimeDatabasePath(workspace)}-wal`)).resolves.toBeUndefined();
        await waitUntilReal(async () => {
          const execution = await inspectAgentExecution(workspace, {
            runId: admitted.run.id,
            target: "review",
          });
          return execution.isOk()
            && execution.value.available
            && execution.value.tokenUsage?.totalTokens === 24;
        });
        const execution = await inspectAgentExecution(workspace, {
          runId: admitted.run.id,
          target: "review",
        });
        expect(execution.isOk() ? execution.value : undefined).toMatchObject({
          available: true,
          contextWindow: { used: 24, size: 100, percent: 24 },
          tokenUsage: {
            source: "usage_update",
            inputTokens: 18,
            outputTokens: 6,
            totalTokens: 24,
          },
        });
        await writeFile(agentRelease, "release");
        await waitUntilReal(async () => fileExists(taskReady));
        const progress = frame(await iterator.next());
        if (progress.kind === "error") throw new Error(JSON.stringify(progress));
        expect(progress).toMatchObject({
          kind: "observation",
          observation: { kind: "update", changes: expect.any(Array) },
        });
        if (progress.kind !== "observation" || progress.observation.kind !== "update") {
          throw new Error("Expected one streamed progress observation.");
        }
        expect(progress.observation.changes).toEqual(expect.arrayContaining([
          expect.objectContaining({ subject: expect.objectContaining({ label: "hold" }), state: { status: "running" } }),
        ]));

        await writeFile(taskRelease, "release");
        const remaining: DaemonRunStreamFrame[] = [];
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          const nextFrame = frame(next);
          remaining.push(nextFrame);
          if (nextFrame.kind === "observation" && nextFrame.observation.kind === "closed") break;
        }
        expect(remaining.at(-1)).toMatchObject({
          kind: "observation",
          observation: {
            kind: "closed",
            reason: "subject-terminal",
            view: { kind: "run", run: { id: admitted.run.id, status: "completed" } },
          },
        });
        expect(await iterator.next()).toMatchObject({ done: true });

        const frames = [admitted, attached, progress, ...remaining];
        expect(frames.some(value => value.kind === "error")).toBe(false);
        expect(JSON.stringify(frames)).not.toMatch(/repair-required|unsupported/i);
        expect(lifecycleInspector).not.toHaveBeenCalled();
      } finally {
        observationTimer?.mockRestore();
        await loop.shutdown();
      }
    });
  }, 15_000);
});

function walProgressWorkflow(paths: {
  agentReady: string;
  agentRelease: string;
  taskReady: string;
  taskRelease: string;
}) {
  return defineWorkflow({
    name: "daemon-wal-observation",
    agents: {
      fixture: {
        command: `${process.execPath} ${fixtureAgent}`,
        env: {
          ACPUS_TEST_AGENT_READY_PATH: paths.agentReady,
          ACPUS_TEST_AGENT_RELEASE_PATH: paths.agentRelease,
        },
      },
    },
  }).build(({ agents, step }) => {
    step("review").agent({ agent: agents.fixture, prompt: "Report usage." });
    step("hold").task({
      input: { readyPath: paths.taskReady, releasePath: paths.taskRelease },
      exec: async ({ input, abortSignal }) => await new Promise<{ ok: boolean }>(resolve => {
        const fs = process.getBuiltinModule("node:fs");
        fs.writeFileSync(input.readyPath, "ready");
        const poll = setInterval(() => {
          if (!fs.existsSync(input.releasePath)) return;
          clearInterval(poll);
          resolve({ ok: true });
        }, 10);
        abortSignal.addEventListener("abort", () => {
          clearInterval(poll);
          resolve({ ok: false });
        }, { once: true });
      }),
    });
    return { ok: true };
  });
}

function frame(
  result: IteratorResult<Result<DaemonRunStreamFrame, DaemonRunStreamClientFailure>>,
): DaemonRunStreamFrame {
  if (result.done || result.value.isErr()) throw new Error("Expected a successful daemon stream frame.");
  return result.value.value;
}


async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilReal(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => realSetTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
