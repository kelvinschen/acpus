import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter as NodeEventEmitter } from "node:events";
import type { LoadedHookConfig } from "../src/hooks/config.js";
import type { HookContext } from "../src/hooks/dispatch.js";
import type { HookJournalEntry } from "../src/hooks/journal.js";

const fake = vi.hoisted(() => ({
  now: 0,
  spawnElapsedMs: 0,
  spawnError: undefined as Error | undefined,
  child: undefined as ({ emit(event: string, ...args: unknown[]): void } | undefined),
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: vi.fn(() => {
      fake.now += fake.spawnElapsedMs;
      if (fake.spawnError) throw fake.spawnError;
      const child = new EventEmitter() as NodeEventEmitter & {
        pid: number | undefined;
        stdin: NodeEventEmitter & { end(value: string): void };
        stdout: NodeEventEmitter;
        stderr: NodeEventEmitter;
      };
      child.pid = undefined;
      child.stdin = Object.assign(new EventEmitter(), { end: () => undefined });
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      fake.child = child;
      return child;
    }),
  };
});

import { createHookRunner } from "../src/hooks/runner.js";

beforeEach(() => {
  fake.now = 0;
  fake.spawnElapsedMs = 0;
  fake.spawnError = undefined;
  fake.child = undefined;
  vi.spyOn(globalThis.performance, "now").mockImplementation(() => fake.now);
});

afterEach(() => vi.restoreAllMocks());

describe("hook runner timeout arbitration", () => {
  it("counts synchronous spawn time against the hook timeout", async () => {
    fake.spawnElapsedMs = 11;
    const journal = journalWriter();
    const runner = createHookRunner([hook("10ms")], journal);

    runner.trigger("run.completed", context());
    fake.child!.emit("close", 0);
    await runner.drain();

    expect(journal.entries).toEqual([expect.objectContaining({ status: "timed_out", error: "timeout" })]);
  });

  it.each(["close", "error"] as const)("lets an expired deadline win when %s arrives before the timer callback", async event => {
    const journal = journalWriter();
    const runner = createHookRunner([hook("10ms")], journal);

    runner.trigger("run.completed", context());
    fake.now = 11;
    if (event === "close") fake.child!.emit("close", 0);
    else fake.child!.emit("error", new Error("late failure"));
    await runner.drain();

    expect(journal.entries).toEqual([expect.objectContaining({ status: "timed_out", error: "timeout" })]);
  });

  it("records a synchronous spawn failure as a terminal hook result", async () => {
    fake.spawnError = new Error("spawn failed");
    const journal = journalWriter();
    const runner = createHookRunner([hook("10ms")], journal);

    runner.trigger("run.completed", context());
    await runner.drain();

    expect(journal.entries).toEqual([expect.objectContaining({ status: "failed", error: "spawn failed" })]);
  });
});

function hook(timeout: string): LoadedHookConfig {
  return {
    event: "run.completed",
    command: "hook-command",
    source: "project",
    sourcePath: "/workspace/.acpus/hooks.json",
    definitionIndex: 0,
    definitionHash: "hook-hash",
    effectiveId: "hook",
    id: "hook",
    timeout,
  };
}

function context(): HookContext {
  return {
    event: "run.completed",
    eventSequence: 42,
    run: {
      id: "run_1",
      workflowName: "release",
      workflowPath: "/workspace/workflow.ts",
      workspaceDir: "/workspace",
      status: "completed",
    },
  };
}

function journalWriter(): { entries: HookJournalEntry[]; writeHookJournal(entry: HookJournalEntry): void } {
  return {
    entries: [],
    writeHookJournal(entry) {
      this.entries.push(entry);
    },
  };
}
