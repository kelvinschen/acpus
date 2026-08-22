import type { OwnedProcessError, ProcessExit, OwnedProcess, ProcessHostShape } from "@acpus/owned-process";
import { tryParseDurationMs } from "@acpus/core/ir";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import type { HookEvent, HookMatch, LoadedHookConfig } from "./config.js";
import type { HookContext } from "./dispatch.js";
import type { HookJournalEntry } from "./journal.js";

export type HookRunner = {
  trigger(event: HookEvent, context: HookContext): void;
  drain(): Effect.Effect<void>;
  activeCount(): number;
};

export type HookJournalWriter = {
  writeHookJournal(entry: HookJournalEntry): void;
};

type HookJob = Readonly<{
  effect: Effect.Effect<void>;
  discard(): void;
}>;

type CommandResult = {
  status: HookJournalEntry["status"];
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: string;
};

type ProcessOutcome =
  | { type: "closed"; exit: ProcessExit }
  | { type: "failed"; error: OwnedProcessError }
  | { type: "timed_out" };

const defaultTimeout = "30s";
const terminationGraceMs = 2_000;
const outputLimit = 4 * 1024;

export function createHookRunner(
  hooks: readonly LoadedHookConfig[],
  journal: HookJournalWriter,
  processes: ProcessHostShape,
  options: { now?: () => Date } = {},
): Effect.Effect<HookRunner, never, Scope.Scope> {
  return Effect.gen(function*() {
    const now = options.now ?? (() => new Date());
    const jobs = yield* Effect.acquireRelease(
      Queue.unbounded<HookJob, Cause.Done>(),
      jobs => Queue.clear(jobs).pipe(
        Effect.tap(pending => Effect.sync(() => {
          for (const job of pending) job.discard();
        })),
        Effect.ensuring(Effect.sync(() => {
          Queue.endUnsafe(jobs);
        })),
        Effect.asVoid,
      ),
    );
    const active = new Set<number>();
    let idle = completedDeferred();
    let nextInvocation = 1;
    let nextTriggerOrder = 1;

    const settle = (invocation: number): void => {
      active.delete(invocation);
      if (active.size === 0) Deferred.doneUnsafe(idle, Effect.void);
    };

    yield* Stream.fromQueue(jobs).pipe(
      Stream.runForEach(job => Effect.forkScoped(job.effect).pipe(
        Effect.uninterruptible,
        Effect.asVoid,
      )),
      Effect.forkScoped,
    );

    return {
      trigger(event, context) {
        for (const hook of hooks) {
          if (hook.event !== event || !matches(hook.match, context)) continue;
          if (active.size === 0) idle = Deferred.makeUnsafe<void>();
          const invocation = nextInvocation++;
          const startedAt = now();
          const triggerOrder = nextTriggerOrder++;
          active.add(invocation);
          const discard = () => settle(invocation);
          const effect = spawnHook(
            hook,
            context,
            startedAt,
            triggerOrder,
            journal,
            processes,
            now,
          ).pipe(
            Effect.catchCause(() => Effect.void),
            Effect.ensuring(Effect.sync(discard)),
          );
          if (!Queue.offerUnsafe(jobs, { effect, discard })) discard();
        }
      },
      drain: () => Effect.suspend(() => Deferred.await(idle)),
      activeCount: () => active.size,
    };
  });
}

function completedDeferred(): Deferred.Deferred<void> {
  const deferred = Deferred.makeUnsafe<void>();
  Deferred.doneUnsafe(deferred, Effect.void);
  return deferred;
}

function matches(match: HookMatch | undefined, context: HookContext): boolean {
  if (!match) return true;
  return matchesField(match.workflow, context.run.workflowName)
    && matchesField(match.nodeId, context.node?.id)
    && matchesField(match.nodeKey, context.node?.key)
    && matchesField(match.kind, context.node?.kind);
}

function matchesField(regex: string | undefined, value: string | undefined): boolean {
  return regex === undefined || (value !== undefined && new RegExp(regex).test(value));
}

function spawnHook(
  hook: LoadedHookConfig,
  context: HookContext,
  startedAt: Date,
  triggerOrder: number,
  journal: HookJournalWriter,
  processes: ProcessHostShape,
  now: () => Date,
): Effect.Effect<void> {
  const timeout = tryParseDurationMs(hook.timeout ?? defaultTimeout);
  if (Result.isFailure(timeout)) return Effect.void;
  const startedMs = startedAt.getTime();
  return runShellCommand(hook.command, context, timeout.success, processes).pipe(
    Effect.flatMap(result => Effect.sync(() => writeJournal(journal, journalEntry(hook, context, triggerOrder, {
      ...result,
      durationMs: Math.max(0, now().getTime() - startedMs),
      triggeredAt: startedAt.toISOString(),
    })))),
  );
}

function runShellCommand(
  command: string,
  context: HookContext,
  timeoutMs: number,
  processes: ProcessHostShape,
): Effect.Effect<CommandResult> {
  return Effect.scoped(Effect.gen(function*() {
    const timeoutStartedAt = yield* Clock.monotonicTimeNanos;
    const spawned = yield* Effect.result(processes.spawn({
      command,
      shell: true,
      cwd: context.run.workspaceDir,
      detached: globalThis.process.platform !== "win32",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }));
    if (Result.isFailure(spawned)) {
      const timedOut = yield* deadlineExpired(timeoutStartedAt, timeoutMs);
      return {
        status: timedOut ? "timed_out" : "failed",
        stdout: "",
        stderr: "",
        error: timedOut ? "timeout" : spawned.failure.message,
      };
    }

    const child = spawned.success;
    const stdout = new OutputCollector(outputLimit);
    const stderr = new OutputCollector(outputLimit);
    const stdoutFiber = yield* collectOutput(child.stdout, stdout).pipe(Effect.forkScoped);
    const stderrFiber = yield* collectOutput(child.stderr, stderr).pipe(Effect.forkScoped);
    if (child.stdin !== undefined) {
      yield* writeStdin(child.stdin, JSON.stringify(context)).pipe(
        Effect.ignore,
        Effect.forkScoped,
      );
    }

    const remainingTimeoutMs = yield* deadlineRemaining(timeoutStartedAt, timeoutMs);
    let outcome = yield* Effect.raceFirst(
      processOutcome(child),
      Effect.sleep(remainingTimeoutMs).pipe(
        Effect.flatMap(() => terminate(child)),
        Effect.as<ProcessOutcome>({ type: "timed_out" }),
      ),
    );
    if (outcome.type !== "timed_out" && (yield* deadlineExpired(timeoutStartedAt, timeoutMs))) {
      yield* terminate(child);
      outcome = { type: "timed_out" };
    }

    if (outcome.type !== "failed") {
      yield* Fiber.join(stdoutFiber);
      yield* Fiber.join(stderrFiber);
    }
    return commandResult(outcome, stdout.toString(), stderr.toString());
  }));
}

function processOutcome(child: OwnedProcess): Effect.Effect<ProcessOutcome> {
  return child.closed.pipe(Effect.match({
    onFailure: error => ({ type: "failed" as const, error }),
    onSuccess: exit => ({ type: "closed" as const, exit }),
  }));
}

function terminate(child: OwnedProcess): Effect.Effect<void> {
  return Effect.gen(function*() {
    yield* child.signal("SIGTERM").pipe(Effect.ignore);
    const exitedDuringGrace = yield* Effect.raceFirst(
      child.closed.pipe(Effect.ignore, Effect.as(true)),
      Effect.sleep(terminationGraceMs).pipe(Effect.as(false)),
    );
    if (exitedDuringGrace) return;
    yield* child.signal("SIGKILL").pipe(Effect.ignore);
    yield* child.closed.pipe(Effect.ignore);
  });
}

function deadlineExpired(startedAt: bigint, timeoutMs: number): Effect.Effect<boolean> {
  return deadlineRemaining(startedAt, timeoutMs).pipe(Effect.map(remaining => remaining <= 0));
}

function deadlineRemaining(startedAt: bigint, timeoutMs: number): Effect.Effect<number> {
  return Clock.monotonicTimeNanos.pipe(Effect.map(now =>
    Math.max(0, timeoutMs - Number(now - startedAt) / 1_000_000)));
}

function collectOutput(
  output: OwnedProcess["stdout"],
  collector: OutputCollector,
): Effect.Effect<void> {
  return Stream.runForEach(output, chunk => Effect.sync(() => collector.append(Buffer.from(chunk)))).pipe(
    Effect.ignore,
  );
}

function writeStdin(stdin: WritableStream<Uint8Array>, value: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const writer = stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(value));
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    },
    catch: cause => cause,
  });
}

function commandResult(outcome: ProcessOutcome, stdout: string, stderr: string): CommandResult {
  if (outcome.type === "timed_out") {
    return { status: "timed_out", stdout, stderr, error: "timeout" };
  }
  if (outcome.type === "failed") {
    return { status: "failed", stdout, stderr, error: outcome.error.message };
  }
  const code = outcome.exit.exitCode;
  return {
    status: code === 0 ? "completed" : "failed",
    ...(code === null ? {} : { exitCode: code }),
    stdout,
    stderr,
    ...(code === 0 ? {} : { error: `exit_code_${code ?? "null"}` }),
  };
}

function journalEntry(
  hook: LoadedHookConfig,
  context: HookContext,
  triggerOrder: number,
  result: {
    status: HookJournalEntry["status"];
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    error?: string;
    triggeredAt: string;
  },
): HookJournalEntry {
  return {
    runId: context.run.id,
    eventSequence: context.eventSequence,
    triggerOrder,
    event: context.event,
    source: hook.source,
    sourcePath: hook.sourcePath,
    handlerId: hook.id ?? hook.effectiveId,
    ...(context.node?.key === undefined ? {} : { nodeKey: context.node.key }),
    status: result.status,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result.error === undefined ? {} : { error: result.error }),
    triggeredAt: result.triggeredAt,
  };
}

function writeJournal(journal: HookJournalWriter, entry: HookJournalEntry): void {
  try {
    journal.writeHookJournal(entry);
  } catch {
    // Hooks are non-interfering; journal failures must not affect workflow execution.
  }
}

class OutputCollector {
  private full: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private head: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private total = 0;
  private truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    const nextTotal = this.total + chunk.length;
    if (!this.truncated && nextTotal <= this.limit * 2) {
      this.full = Buffer.concat([this.full, chunk]);
      this.total = nextTotal;
      return;
    }

    if (!this.truncated) {
      this.head = this.full.length >= this.limit
        ? this.full.subarray(0, this.limit)
        : Buffer.concat([this.full, chunk.subarray(0, this.limit - this.full.length)]);
      this.tail = lastBytes(this.full.subarray(Math.max(0, this.full.length - this.limit)), chunk, this.limit);
      this.full = Buffer.alloc(0);
      this.truncated = true;
      this.total = nextTotal;
      return;
    }

    this.total += chunk.length;
    this.tail = lastBytes(this.tail, chunk, this.limit);
  }

  toString(): string {
    return boundedUtf8(this.truncated ? Buffer.concat([this.head, this.tail]) : this.full, this.limit * 2);
  }
}

function lastBytes(previousTail: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  const combined = Buffer.concat([previousTail, chunk]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}

function boundedUtf8(buffer: Buffer, maxBytes: number): string {
  let end = Math.min(buffer.length, maxBytes);
  while (end >= 0) {
    const value = buffer.subarray(0, end).toString("utf8");
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    end -= 1;
  }
  return "";
}
