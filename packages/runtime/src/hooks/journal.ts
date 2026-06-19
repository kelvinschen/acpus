import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HookJournalEntry } from "@acpus/core";

/**
 * Append-only per-Run journal of injector handler invocations.
 *
 * One line of JSON per handler call, storing the full resolved Agent prompt
 * prefix and Program env (not a boolean flag) for audit/observability. Events
 * are never journaled.
 */
export class HookJournal {
  private readonly path: string;
  private sequence: number;

  constructor(runDir: string) {
    this.path = join(runDir, "hook-journal.jsonl");
    this.sequence = this.lastSequence();
  }

  /** Append one injector record, assigning the next monotonic sequence. */
  append(entry: Omit<HookJournalEntry, "sequence">): HookJournalEntry {
    const full: HookJournalEntry = { sequence: ++this.sequence, ...entry };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  /** Read all journal records in append order. */
  read(): HookJournalEntry[] {
    if (!existsSync(this.path)) return [];
    const entries: HookJournalEntry[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      // appendFileSync is not atomic; a crash mid-append can leave a torn final
      // line. Skip unparseable lines rather than throwing on the whole journal.
      try {
        entries.push(JSON.parse(line) as HookJournalEntry);
      } catch {
        continue;
      }
    }
    return entries;
  }

  /** Highest sequence already on disk (0 when the journal is empty). */
  private lastSequence(): number {
    const entries = this.read();
    return entries.length > 0 ? entries[entries.length - 1].sequence : 0;
  }
}
