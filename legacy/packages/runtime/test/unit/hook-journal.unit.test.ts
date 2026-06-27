import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookJournal } from "../../src/hooks/journal.js";

describe("HookJournal", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acpus-hook-journal-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("assigns monotonic sequences and stores full prompt prefix + env", () => {
    const journal = new HookJournal(dir);
    journal.append({
      node_key: "workflow/a",
      injector: "beforeAgentExec",
      handler_index: 0,
      node_attempt: 1,
      is_retry: false,
      prepend_prompt: "ctx",
      env: null,
      timestamp: new Date().toISOString(),
      duration_ms: 5
    });
    journal.append({
      node_key: "workflow/b",
      injector: "beforeProgramExec",
      handler_index: 0,
      node_attempt: 1,
      is_retry: false,
      prepend_prompt: null,
      env: { A: "1" },
      timestamp: new Date().toISOString(),
      duration_ms: 7
    });

    const entries = journal.read();
    expect(entries.map((e) => e.sequence)).toEqual([1, 2]);
    expect(entries[0].prepend_prompt).toBe("ctx");
    expect(entries[1].env).toEqual({ A: "1" });
  });

  it("continues the sequence across re-open from disk", () => {
    const first = new HookJournal(dir);
    first.append({
      node_key: "n", injector: "beforeAgentExec", handler_index: 0, node_attempt: 1,
      is_retry: false, prepend_prompt: "a", env: null, timestamp: "t", duration_ms: 1
    });
    const reopened = new HookJournal(dir);
    const entry = reopened.append({
      node_key: "n", injector: "beforeAgentExec", handler_index: 0, node_attempt: 2,
      is_retry: true, prepend_prompt: "b", env: null, timestamp: "t", duration_ms: 1
    });
    expect(entry.sequence).toBe(2);
    expect(reopened.read()).toHaveLength(2);
  });

  it("returns an empty list when no journal exists", () => {
    expect(new HookJournal(dir).read()).toEqual([]);
  });
});
