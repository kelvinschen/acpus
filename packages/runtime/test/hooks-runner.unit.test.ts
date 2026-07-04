import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedHookConfig } from "../src/hooks/config.js";
import type { HookContext } from "../src/hooks/context.js";
import type { HookJournalEntry } from "../src/hooks/journal.js";
import { createHookRunner } from "../src/hooks/runner.js";

describe("hook runner", () => {
  it("runs matching hooks with stdin context and records completion", async () => {
    const journal = journalWriter();
    const runner = createHookRunner([
      hook("run.completed", command("let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).run.id))")),
    ], journal);

    runner.trigger("run.completed", context());
    await runner.drain();

    expect(journal.entries).toMatchObject([
      { status: "completed", exitCode: 0, stdout: "run_1", handlerId: "notify", eventSequence: 42 },
    ]);
  });

  it("filters hooks by event and match regex fields", async () => {
    const journal = journalWriter();
    const runner = createHookRunner([
      hook("run.completed", command("process.stdout.write('no')"), { workflow: "^other" }),
      hook("node.failed", command("process.stdout.write('yes')"), { workflow: "^release$", nodeId: "^build$", nodeKey: "^build~1$", kind: "^task$" }),
    ], journal);

    runner.trigger("run.completed", context());
    runner.trigger("node.failed", context({ event: "node.failed" }));
    await runner.drain();

    expect(journal.entries).toMatchObject([{ status: "completed", stdout: "yes" }]);
  });

  it("records failed exits and timeouts", async () => {
    const journal = journalWriter();
    const runner = createHookRunner([
      hook("run.completed", command("process.stderr.write('bad');process.exit(7)"), undefined, "fail"),
      hook("run.completed", command("setTimeout(()=>{},1000)"), undefined, "timeout", "10ms"),
    ], journal);

    runner.trigger("run.completed", context());
    await runner.drain();

    expect(journal.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ handlerId: "fail", status: "failed", exitCode: 7, stderr: "bad" }),
      expect.objectContaining({ handlerId: "timeout", status: "timed_out", error: "timeout" }),
    ]));
  });

  it("kills shell child processes on timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpus-hook-tree-"));
    const marker = join(dir, "child-ran");
    const journal = journalWriter();
    const runner = createHookRunner([
      hook("run.completed", command(`require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"late"),300)'],{stdio:'inherit'});setTimeout(()=>{},1000)`), undefined, "tree-timeout", "10ms"),
    ], journal);

    try {
      runner.trigger("run.completed", context());
      await runner.drain();
      await new Promise(resolve => setTimeout(resolve, 400));

      await expect(access(marker)).rejects.toThrow();
      expect(journal.entries).toEqual([expect.objectContaining({ handlerId: "tree-timeout", status: "timed_out" })]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs matching hooks without a concurrency limit and records trigger order", async () => {
    const journal = journalWriter();
    const runner = createHookRunner([
      hook("run.completed", command("setTimeout(()=>process.stdout.write('slow'),100)"), undefined, "slow"),
      hook("run.completed", command("process.stdout.write('fast')"), undefined, "fast"),
    ], journal);

    runner.trigger("run.completed", context());
    expect(runner.activeCount()).toBe(2);
    await runner.drain();

    expect(journal.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ handlerId: "slow", status: "completed", triggerOrder: 1 }),
      expect.objectContaining({ handlerId: "fast", status: "completed", triggerOrder: 2 }),
    ]));
    expect(runner.activeCount()).toBe(0);
  });

  it("does not throw when journal writes fail", async () => {
    const runner = createHookRunner([
      hook("run.completed", command("process.stdout.write('ok')")),
    ], { writeHookJournal: () => { throw new Error("db closed"); } });

    expect(() => runner.trigger("run.completed", context())).not.toThrow();
    await expect(runner.drain()).resolves.toBeUndefined();
  });

  it("does not crash when a hook exits before reading stdin", async () => {
    const journal = journalWriter();
    const runner = createHookRunner([
      hook("run.completed", command("process.exit(0)")),
    ], journal);
    const base = context();

    runner.trigger("run.completed", context({
      run: { ...base.run, id: "r".repeat(20 * 1024 * 1024) },
    }));
    await runner.drain();

    expect(journal.entries).toEqual([expect.objectContaining({ status: "completed", exitCode: 0 })]);
  });

  it("truncates large stdout and stderr", async () => {
    const journal = journalWriter();
    const runner = createHookRunner([
      hook("run.completed", command("process.stdout.write('A'.repeat(5000)+'B'.repeat(5000));process.stderr.write('世'.repeat(4000))")),
    ], journal);

    runner.trigger("run.completed", context());
    await runner.drain();

    expect(journal.entries[0]?.stdout).toBe(`${"A".repeat(4096)}${"B".repeat(4096)}`);
    expect(Buffer.byteLength(journal.entries[0]?.stdout ?? "", "utf8")).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(journal.entries[0]?.stderr ?? "", "utf8")).toBeLessThanOrEqual(8192);
  });
});

function hook(event: LoadedHookConfig["event"], commandText: string, match?: LoadedHookConfig["match"], id = "notify", timeout?: string): LoadedHookConfig {
  return {
    event,
    command: commandText,
    source: "project",
    sourcePath: "/workspace/.acpus/hooks.json",
    definitionIndex: 0,
    definitionHash: `${id}-hash`,
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
