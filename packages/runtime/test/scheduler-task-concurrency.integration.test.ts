import { admitRunForTest } from "./support/runtime-store.js";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { advanceFrozenRun } from "./support/effect-scheduler.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { prepareSyntheticWorkflow, withRuntimeWorkspace } from "./support/runtime-harness.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";

describe.concurrent("runtime scheduler Task concurrency", () => {
  it("continuously refills Parallel(2) x Fanout(3) from durable Task completions", async () => {
    await withRuntimeWorkspace("scheduler-task-nested-refill", async workspace => {
      const gateDir = join(workspace, "task-gates");
      const startedDir = join(gateDir, "started");
      const releaseDir = join(gateDir, "release");
      await Promise.all([
        mkdir(startedDir, { recursive: true }),
        mkdir(releaseDir, { recursive: true }),
      ]);
      const prepared = await prepareSyntheticWorkflow(workspace, nestedGatedTaskWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      let advancing: ReturnType<typeof advanceFrozenRun> | undefined;
      try {
        const run = await admitRunForTest(store, {
          prepared,
          input: { gateDir, items: [0, 1, 2, 3] },
          cwd: workspace,
        });
        advancing = advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });

        await waitUntil(async () => (await readdir(startedDir)).length === 6);
        const beforeRelease = store.getCommittedRuntimeEventsAfter(run.id, 0);
        expect(activeAttemptCount(beforeRelease)).toBe(6);

        await writeFile(join(releaseDir, "left-1"), "release");
        await waitUntil(() => store.getCommittedRuntimeEventsAfter(run.id, 0)
          .filter(event => event.type === "attempt.started").length >= 7);
        await writeFile(join(releaseDir, "right-1"), "release");
        await waitUntil(() => store.getCommittedRuntimeEventsAfter(run.id, 0)
          .filter(event => event.type === "attempt.started").length >= 8);
        await expect(access(join(releaseDir, "left-0"))).rejects.toThrow();
        await expect(access(join(releaseDir, "right-0"))).rejects.toThrow();
        expect(activeAttemptCount(store.getCommittedRuntimeEventsAfter(run.id, 0))).toBe(6);

        await Promise.all(["left", "right"].flatMap(branch => [0, 1, 2, 3]
          .map(index => writeFile(join(releaseDir, `${branch}-${index}`), "release"))));
        await expect(advancing).resolves.toMatchObject({ status: "completed", started: 8, completed: 8 });

        const events = store.getCommittedRuntimeEventsAfter(run.id, 0);
        expect(attemptPeak(events)).toBe(6);
        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        const memberPeaks = groupMemberPeaks(events);
        for (const group of Object.values(projection.groups)) {
          expect(memberPeaks.get(group.groupKey) ?? 0).toBeLessThanOrEqual(group.maxConcurrency ?? Number.MAX_SAFE_INTEGER);
        }
        expect(Object.values(projection.groups).map(group => memberPeaks.get(group.groupKey) ?? 0).sort()).toEqual([2, 3, 3]);
      } finally {
        await Promise.all(["left", "right"].flatMap(branch => [0, 1, 2, 3]
          .map(index => writeFile(join(releaseDir, `${branch}-${index}`), "release").catch(() => undefined))));
        if (advancing) await advancing.catch(() => undefined);
        store.close();
      }
    });
  });
});

function nestedGatedTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-task-nested-refill",
    inputSchema: z.object({ gateDir: z.string(), items: z.array(z.number()) }),
  }).build(({ input, step }) => {
    const branches = step("branches").parallel({
      maxConcurrency: 2,
      branches: {
        left() {
          const items = step("left_items").fanout({
            over: input.items,
            maxConcurrency: 3,
            do({ itemIndex }) {
              const task = step("left_gate").task({
                input: { gateDir: input.gateDir, branch: "left", itemIndex },
                exec: gatedTask,
              });
              return task.output;
            },
          });
          return items.output;
        },
        right() {
          const items = step("right_items").fanout({
            over: input.items,
            maxConcurrency: 3,
            do({ itemIndex }) {
              const task = step("right_gate").task({
                input: { gateDir: input.gateDir, branch: "right", itemIndex },
                exec: gatedTask,
              });
              return task.output;
            },
          });
          return items.output;
        },
      },
    });
    return { left: branches.output.left, right: branches.output.right };
  });
}

async function gatedTask({
  input,
  abortSignal,
}: {
  input: { gateDir: string; branch: string; itemIndex: number };
  abortSignal: AbortSignal;
}): Promise<{ branch: string; itemIndex: number }> {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const identity = `${input.branch}-${input.itemIndex}`;
  fs.writeFileSync(path.join(input.gateDir, "started", identity), "started");
  await new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (!fs.existsSync(path.join(input.gateDir, "release", identity))) return;
      clearInterval(poll);
      resolve();
    }, 5);
    abortSignal.addEventListener("abort", () => {
      clearInterval(poll);
      reject(new Error("aborted"));
    }, { once: true });
  });
  return { branch: input.branch, itemIndex: input.itemIndex };
}

type RuntimeEvent = ReturnType<Awaited<ReturnType<typeof openRuntimeStoreAdapter>>["getCommittedRuntimeEventsAfter"]>[number];

const ATTEMPT_TERMINAL_EVENTS = new Set(["attempt.completed", "attempt.failed", "attempt.timed_out", "attempt.cancelled", "attempt.superseded"]);
const MEMBER_TERMINAL_EVENTS = new Set(["group.member_completed", "group.member_failed", "group.member_cancelled"]);

function activeAttemptCount(events: RuntimeEvent[]): number {
  const active = new Set<string>();
  for (const event of events) {
    const attemptId = typeof event.payload.attemptId === "string" ? event.payload.attemptId : undefined;
    if (!attemptId) continue;
    if (event.type === "attempt.started") active.add(attemptId);
    else if (ATTEMPT_TERMINAL_EVENTS.has(event.type)) active.delete(attemptId);
  }
  return active.size;
}

function attemptPeak(events: RuntimeEvent[]): number {
  const active = new Set<string>();
  let peak = 0;
  for (const event of events) {
    const attemptId = typeof event.payload.attemptId === "string" ? event.payload.attemptId : undefined;
    if (!attemptId) continue;
    if (event.type === "attempt.started") active.add(attemptId);
    else if (ATTEMPT_TERMINAL_EVENTS.has(event.type)) active.delete(attemptId);
    peak = Math.max(peak, active.size);
  }
  return peak;
}

function groupMemberPeaks(events: RuntimeEvent[]): Map<string, number> {
  const groupForMember = new Map<string, string>();
  const activeByGroup = new Map<string, Set<string>>();
  const peakByGroup = new Map<string, number>();
  for (const event of events) {
    const memberKey = typeof event.payload.memberKey === "string" ? event.payload.memberKey : undefined;
    if (!memberKey) continue;
    if (event.type === "group.member_ready" && typeof event.payload.groupKey === "string") {
      groupForMember.set(memberKey, event.payload.groupKey);
      continue;
    }
    const groupKey = groupForMember.get(memberKey);
    if (!groupKey) continue;
    const active = activeByGroup.get(groupKey) ?? new Set<string>();
    activeByGroup.set(groupKey, active);
    if (event.type === "group.member_started") active.add(memberKey);
    else if (MEMBER_TERMINAL_EVENTS.has(event.type)) active.delete(memberKey);
    peakByGroup.set(groupKey, Math.max(peakByGroup.get(groupKey) ?? 0, active.size));
  }
  return peakByGroup;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
