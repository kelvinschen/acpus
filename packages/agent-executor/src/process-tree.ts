import type {
  ProcessIdentityLiveness,
  ProcessLiveness,
  ProcessHostShape,
  ProcessTarget,
} from "@acpus/owned-process";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export const PROCESS_TREE_CLEANUP_BUDGET_MS = 5_000;

const TERM_GRACE_MS = 1_000;
const nanosPerMillisecond = 1_000_000n;

export type ProcessTreeDeadline = bigint;
export type ProcessGroupLiveness = ProcessLiveness;

export function processTreeDeadline(budgetMs: number): Effect.Effect<ProcessTreeDeadline> {
  return Clock.monotonicTimeNanos.pipe(
    Effect.map(now => now + BigInt(Math.max(0, Math.ceil(budgetMs))) * nanosPerMillisecond),
  );
}

export function stopProcessTree(
  processes: ProcessHostShape,
  target: ProcessTarget,
  deadline: ProcessTreeDeadline,
): Effect.Effect<boolean> {
  return stopProcessTreeWithDisposition(processes, target, deadline).pipe(
    Effect.map(stopped => stopped.alive),
  );
}

export function stopProcessTreeWithDisposition(
  processes: ProcessHostShape,
  target: ProcessTarget,
  deadline: ProcessTreeDeadline,
): Effect.Effect<Readonly<{
  alive: boolean;
  disposition: "cooperative" | "term" | "kill" | "unverified";
}>> {
  return Effect.gen(function*() {
    const initial = yield* processes.liveness(target);
    if (initial === "dead") return { alive: false, disposition: "cooperative" as const };
    if (initial === "unverified") return { alive: true, disposition: "unverified" as const };

    yield* processes.signal(target, "SIGTERM").pipe(Effect.ignore);
    yield* waitForTreeDeath(processes, target, deadline, TERM_GRACE_MS);
    if ((yield* processes.liveness(target)) === "dead") {
      return { alive: false, disposition: "term" as const };
    }

    yield* processes.signal(target, "SIGKILL").pipe(Effect.ignore);
    yield* waitForTreeDeath(processes, target, deadline);
    const liveness = yield* processes.liveness(target);
    return {
      alive: liveness !== "dead",
      disposition: liveness === "dead" ? "kill" as const : "unverified" as const,
    };
  });
}

export function matchesProcessStartToken(
  processes: ProcessHostShape,
  pid: number,
  expected: string | undefined,
): Effect.Effect<boolean | undefined> {
  return processes.identityLiveness(pid, expected).pipe(Effect.map(liveness =>
    liveness === "match" ? true : liveness === "absent" || liveness === "mismatch" ? false : undefined));
}

export function processIdentityLiveness(
  processes: ProcessHostShape,
  pid: number,
  expected: string | undefined,
): Effect.Effect<ProcessIdentityLiveness> {
  return processes.identityLiveness(pid, expected);
}

export function processGroupLiveness(
  processes: ProcessHostShape,
  target: ProcessTarget,
): Effect.Effect<ProcessGroupLiveness> {
  return processes.liveness(target);
}

function waitForTreeDeath(
  processes: ProcessHostShape,
  target: ProcessTarget,
  deadline: ProcessTreeDeadline,
  maximumMs = Number.POSITIVE_INFINITY,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    const ownDeadline = maximumMs === Number.POSITIVE_INFINITY
      ? deadline
      : yield* processTreeDeadline(maximumMs).pipe(Effect.map(value => value < deadline ? value : deadline));
    while (yield* beforeDeadline(ownDeadline)) {
      if ((yield* processes.liveness(target)) !== "live") return;
      const remainingMs = yield* remaining(ownDeadline);
      yield* Effect.sleep(Math.min(50, Math.max(1, remainingMs)));
    }
  });
}

export function remaining(deadline: ProcessTreeDeadline): Effect.Effect<number> {
  return Clock.monotonicTimeNanos.pipe(Effect.map(now =>
    Math.max(0, Math.floor(Number(deadline - now) / 1_000_000))));
}

function beforeDeadline(deadline: ProcessTreeDeadline): Effect.Effect<boolean> {
  return Clock.monotonicTimeNanos.pipe(Effect.map(now => now < deadline));
}
