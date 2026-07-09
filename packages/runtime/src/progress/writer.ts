import type { RuntimeStore, WriteNodeProgressInput } from "../store/store.js";

const DEFAULT_PROGRESS_FLUSH_INTERVAL_MS = 1_000;
const TERMINAL_PROGRESS_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export type NodeProgressWriter = {
  writeNodeProgress(input: WriteNodeProgressInput): void;
};

export class CoalescingNodeProgressWriter implements NodeProgressWriter {
  private readonly pending = new Map<string, WriteNodeProgressInput>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly store: RuntimeStore, private readonly flushIntervalMs = DEFAULT_PROGRESS_FLUSH_INTERVAL_MS) {}

  writeNodeProgress(input: WriteNodeProgressInput): void {
    if (TERMINAL_PROGRESS_STATUSES.has(input.status)) {
      this.pending.delete(progressKey(input));
      this.flushNow(input);
      return;
    }
    this.pending.set(progressKey(input), input);
    this.schedule();
  }

  flushAll(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const snapshots = [...this.pending.values()];
    this.pending.clear();
    for (const snapshot of snapshots) this.flushNow(snapshot);
  }

  flushMatching(match: (input: WriteNodeProgressInput) => boolean): void {
    for (const [key, snapshot] of [...this.pending.entries()]) {
      if (!match(snapshot)) continue;
      this.pending.delete(key);
      this.flushNow(snapshot);
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushAll();
    }, this.flushIntervalMs);
  }

  private flushNow(input: WriteNodeProgressInput): void {
    try {
      this.store.writeNodeProgress(input);
    } catch {
      // Progress is an inspect convenience projection; it must not alter run outcome.
    }
  }
}

function progressKey(input: WriteNodeProgressInput): string {
  return `${input.runId}\0${input.nodeKey}`;
}
