import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import type { Result } from "neverthrow";
import {
  getRun,
  requestDaemonControl as requestDaemonControlResult,
  requestDaemonShutdown as requestDaemonShutdownResult,
  requestDaemonStatus as requestDaemonStatusResult,
  type DaemonClientFailure,
} from "../../src/index.js";
import { setRuntimeHomeForTest } from "../../src/runtime-layout.js";
import { openRuntimeStore, type RuntimeStore } from "../../src/store/store.js";

export type DaemonLeaseFixture = {
  dir: string;
  store: RuntimeStore;
};

export async function withDaemonLeaseWorkspace<T>(
  test: (fixture: DaemonLeaseFixture) => Promise<T>,
): Promise<T> {
  const [dir, home] = await Promise.all([
    mkdtemp(join(tmpdir(), "acpus-daemon-")),
    mkdtemp(join(tmpdir(), "acpus-daemon-home-")),
  ]);
  const restoreHome = setRuntimeHomeForTest(dir, home);
  let store: RuntimeStore | undefined;
  try {
    store = await openRuntimeStore(dir);
    return await test({ dir, store });
  } finally {
    store?.close();
    restoreHome();
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  }
}

export async function requestDaemonControl(
  ...args: Parameters<typeof requestDaemonControlResult>
) {
  return unwrapDaemon(await requestDaemonControlResult(...args));
}

export async function requestDaemonShutdown(
  ...args: Parameters<typeof requestDaemonShutdownResult>
) {
  return unwrapDaemon(await requestDaemonShutdownResult(...args));
}

export async function requestDaemonStatus(
  ...args: Parameters<typeof requestDaemonStatusResult>
) {
  return unwrapDaemon(await requestDaemonStatusResult(...args));
}

function unwrapDaemon<T>(result: Result<T, DaemonClientFailure>): T {
  if (result.isOk()) return result.value;
  throw Object.assign(
    new Error(result.error.message),
    result.error.type === "rejected" ? { code: result.error.code } : {},
  );
}

export function activeTaskWorkflow() {
  return defineWorkflow({
    name: "daemon-active-cancel",
    inputSchema: z.object({ markerPath: z.string().optional() }),
  }).build(({ input, step }) => {
    const task = step("slow_task").task({
      input: { markerPath: input.markerPath },
      exec: async ({ input, abortSignal }) => await new Promise<{ ok: boolean }>(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (input.markerPath) {
            process.getBuiltinModule("node:fs").writeFileSync(input.markerPath, "aborted");
          }
          resolve({ ok: false });
        };
        abortSignal.addEventListener("abort", finish, { once: true });
        if (abortSignal.aborted) finish();
        else if (input.markerPath) {
          process.getBuiltinModule("node:fs").writeFileSync(input.markerPath, "started");
        }
      }),
    });
    return { ok: task.output.ok };
  });
}

export function targetedParallelTaskWorkflow() {
  return defineWorkflow({
    name: "daemon-targeted-active-cancel",
    inputSchema: z.object({
      leftMarker: z.string(),
      rightMarker: z.string(),
      rightRelease: z.string(),
    }),
  }).build(({ input, step }) => {
    const race = step("race").parallel({
      strategy: "race",
      branches: {
        left() {
          const task = step("left_task").task({
            input: { markerPath: input.leftMarker, value: "left" },
            exec: cancellableMarkerTask,
          });
          return { value: task.output.value };
        },
        right() {
          const task = step("right_task").task({
            input: {
              markerPath: input.rightMarker,
              releasePath: input.rightRelease,
              value: "right",
            },
            exec: cancellableMarkerTask,
          });
          return { value: task.output.value };
        },
      },
    });
    return { winner: race.output.winner, value: race.output.result.value };
  });
}

async function cancellableMarkerTask({
  input,
  abortSignal,
}: {
  input: { markerPath: string; value: string; releasePath?: string };
  abortSignal: AbortSignal;
}): Promise<{ value: string }> {
  return await new Promise(resolve => {
    let settled = false;
    let releasePoll: ReturnType<typeof setInterval> | undefined;
    const finish = (marker: string) => {
      if (settled) return;
      settled = true;
      if (releasePoll) clearInterval(releasePoll);
      process.getBuiltinModule("node:fs").writeFileSync(input.markerPath, marker);
      resolve({ value: input.value });
    };
    const releasePath = input.releasePath;
    if (releasePath) {
      releasePoll = setInterval(() => {
        if (process.getBuiltinModule("node:fs").existsSync(releasePath)) finish("completed");
      }, 10);
    }
    abortSignal.addEventListener("abort", () => finish("aborted"), { once: true });
    if (abortSignal.aborted) finish("aborted");
    else process.getBuiltinModule("node:fs").writeFileSync(input.markerPath, "started");
  });
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

export async function waitForTerminalRun(
  cwd: string,
  runId: string,
): Promise<{
  status: string;
  run: NonNullable<ReturnType<Awaited<ReturnType<typeof getRun>>["_unsafeUnwrap"]>>;
}> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = (await getRun(cwd, runId))._unsafeUnwrap();
    if (run && ["completed", "failed", "canceled"].includes(run.status)) {
      return { status: run.status, run };
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Run '${runId}' did not become terminal.`);
}
