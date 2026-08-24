import { makeNodeProcessHost } from "@acpus/owned-process";
import { describe, expect, it } from "@effect/vitest";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { LoadedHookConfig } from "../src/hooks/config.js";
import type { HookContext } from "../src/hooks/dispatch.js";
import type { HookJournalEntry } from "../src/hooks/journal.js";
import { createHookRunner } from "../src/hooks/runner.js";

const processes = makeNodeProcessHost();

describe("hook runner", () => {
  it.live("runs matching hooks with stdin context and records completion", () =>
    Effect.gen(function*() {
      const journal = journalWriter();
      const runner = yield* createHookRunner([
        hook("run.completed", command("let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).run.id))")),
      ], journal, processes);

      runner.trigger("run.completed", context());
      yield* runner.drain();

      expect(journal.entries).toMatchObject([
        { status: "completed", exitCode: 0, stdout: "run_1", handlerId: "notify", eventSequence: 42 },
      ]);
    }));

  it.live("filters hooks by event and match regex fields", () =>
    Effect.gen(function*() {
      const journal = journalWriter();
      const runner = yield* createHookRunner([
        hook("run.completed", command("process.stdout.write('no')"), { workflow: "^other" }),
        hook("node.failed", command("process.stdout.write('yes')"), { workflow: "^release$", nodeId: "^build$", nodeKey: "^build~1$", kind: "^task$" }),
      ], journal, processes);

      runner.trigger("run.completed", context());
      runner.trigger("node.failed", context({ event: "node.failed" }));
      yield* runner.drain();

      expect(journal.entries).toMatchObject([{ status: "completed", stdout: "yes" }]);
    }));

  it.live("records failed exits and timeouts", () =>
    Effect.gen(function*() {
      const journal = journalWriter();
      const runner = yield* createHookRunner([
        hook("run.completed", command("process.stderr.write('bad');process.exit(7)"), undefined, "fail"),
        hook("run.completed", command("setTimeout(()=>{},1000)"), undefined, "timeout", "10ms"),
      ], journal, processes);

      runner.trigger("run.completed", context());
      yield* runner.drain();

      expect(journal.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ handlerId: "fail", status: "failed", exitCode: 7, stderr: "bad" }),
        expect.objectContaining({ handlerId: "timeout", status: "timed_out", error: "timeout" }),
      ]));
    }));

  it.live("does not overflow long hook timeouts", () =>
    Effect.gen(function*() {
      const journal = journalWriter();
      const runner = yield* createHookRunner([
        hook("run.completed", command("process.stdout.write('ok')"), undefined, "long-timeout", "2147543647ms"),
      ], journal, processes);

      runner.trigger("run.completed", context());
      yield* runner.drain();

      expect(journal.entries).toEqual([
        expect.objectContaining({ handlerId: "long-timeout", status: "completed", stdout: "ok" }),
      ]);
    }));

  it.live("kills shell child processes on timeout", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "acpus-hook-tree-"))),
        dir => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.orDie),
      );
      const marker = join(dir, "child-ran");
      const journal = journalWriter();
      const runner = yield* createHookRunner([
        hook("run.completed", command(`require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"late"),300)'],{stdio:'inherit'});setTimeout(()=>{},1000)`), undefined, "tree-timeout", "10ms"),
      ], journal, processes);

      runner.trigger("run.completed", context());
      yield* runner.drain();
      yield* Effect.sleep(400);

      yield* Effect.promise(async () => {
        await expect(access(marker)).rejects.toThrow();
      });
      expect(journal.entries).toEqual([expect.objectContaining({ handlerId: "tree-timeout", status: "timed_out" })]);
    }));

  it.live("runs matching hooks without a concurrency limit and records trigger order", () =>
    Effect.gen(function*() {
      const journal = journalWriter();
      const runner = yield* createHookRunner([
        hook("run.completed", command("setTimeout(()=>process.stdout.write('slow'),100)"), undefined, "slow"),
        hook("run.completed", command("process.stdout.write('fast')"), undefined, "fast"),
      ], journal, processes);

      runner.trigger("run.completed", context());
      expect(runner.activeCount()).toBe(2);
      yield* runner.drain();

      expect(journal.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ handlerId: "slow", status: "completed", triggerOrder: 1 }),
        expect.objectContaining({ handlerId: "fast", status: "completed", triggerOrder: 2 }),
      ]));
      expect(runner.activeCount()).toBe(0);
    }));

  it.live("does not throw when journal writes fail", () =>
    Effect.gen(function*() {
      const runner = yield* createHookRunner([
        hook("run.completed", command("process.stdout.write('ok')")),
      ], { writeHookJournal: () => { throw new Error("db closed"); } }, processes);

      expect(() => runner.trigger("run.completed", context())).not.toThrow();
      yield* runner.drain();
    }));

  it.live("does not crash when a hook exits before reading stdin", () =>
    Effect.gen(function*() {
      const journal = journalWriter();
      const runner = yield* createHookRunner([
        hook("run.completed", command("process.exit(0)")),
      ], journal, processes);
      const base = context();

      runner.trigger("run.completed", context({
        run: { ...base.run, id: "r".repeat(20 * 1024 * 1024) },
      }));
      yield* runner.drain();

      expect(journal.entries).toEqual([expect.objectContaining({ status: "completed", exitCode: 0 })]);
    }));

  it.live("truncates large stdout and stderr", () =>
    Effect.gen(function*() {
      const journal = journalWriter();
      const runner = yield* createHookRunner([
        hook("run.completed", command("process.stdout.write('A'.repeat(5000)+'B'.repeat(5000));process.stderr.write('世'.repeat(4000))")),
      ], journal, processes);

      runner.trigger("run.completed", context());
      yield* runner.drain();

      expect(journal.entries[0]?.stdout).toBe(`${"A".repeat(4096)}${"B".repeat(4096)}`);
      expect(Buffer.byteLength(journal.entries[0]?.stdout ?? "", "utf8")).toBeLessThanOrEqual(8192);
      expect(Buffer.byteLength(journal.entries[0]?.stderr ?? "", "utf8")).toBeLessThanOrEqual(8192);
    }));
});

function hook(event: LoadedHookConfig["event"], commandText: string, match?: LoadedHookConfig["match"], id = "notify", timeout?: string): LoadedHookConfig {
  return {
    event,
    command: commandText,
    source: "project",
    sourcePath: "/workspace/.acpus/config.json",
    definitionIndex: 0,
    effectiveId: id,
    id,
    ...(match === undefined ? {} : { match }),
    ...(timeout === undefined ? {} : { timeout }),
  };
}

function command(script: string): string {
  return `${process.execPath} -e "${script.replaceAll("\"", "\\\"")}"`;
}

function context(overrides: Partial<HookContext> = {}): HookContext {
  return {
    event: "run.completed",
    eventSequence: 42,
    run: {
      id: "run_1",
      workflowName: "release",
      workflowPath: "/workspace/workflow.ts",
      workspaceDir: process.cwd(),
      status: "completed",
    },
    node: {
      id: "build",
      key: "build~1",
      kind: "task",
      status: "completed",
    },
    ...overrides,
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
