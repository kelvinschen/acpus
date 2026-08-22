import type { WriteNodeProgressInput } from "../store/store.js";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

const DEFAULT_PROGRESS_FLUSH_INTERVAL_MS = 1_000;
const TERMINAL_PROGRESS_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export type NodeProgressWriter = {
  writeNodeProgress(input: WriteNodeProgressInput): void;
};

export class CoalescingNodeProgressWriter implements NodeProgressWriter {
  private readonly pending = new Map<string, WriteNodeProgressInput>();
  private started = false;

  constructor(private readonly target: NodeProgressWriter, private readonly flushIntervalMs = DEFAULT_PROGRESS_FLUSH_INTERVAL_MS) {}

  start(scope: Scope.Scope): Effect.Effect<void> {
    if (this.started) return Effect.void;
    this.started = true;
    return Effect.sleep(this.flushIntervalMs).pipe(
      Effect.andThen(Effect.sync(() => this.flushAll())),
      Effect.forever,
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  }

  writeNodeProgress(input: WriteNodeProgressInput): void {
    if (TERMINAL_PROGRESS_STATUSES.has(input.status)) {
      this.pending.delete(progressKey(input));
      this.flushNow(input);
      return;
    }
    this.pending.set(progressKey(input), input);
  }

  flushAll(): void {
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

  private flushNow(input: WriteNodeProgressInput): void {
    try {
      this.target.writeNodeProgress(input);
    } catch {
      // Progress is an inspect convenience projection; it must not alter run outcome.
    }
  }
}

function progressKey(input: WriteNodeProgressInput): string {
  return `${input.runId}\0${input.nodeKey}\0${input.attemptId}\0${input.ownerEpoch}`;
}
