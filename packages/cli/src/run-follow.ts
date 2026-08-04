import {
  observeInspection,
  type InspectionError,
  type InspectionObservation,
  type InspectionView,
  type InspectionViewQuery,
} from "@acpus/runtime";
import type { Writable } from "node:stream";
import {
  formatDurationMs,
  formatInspectionChanges,
  formatInspectionError,
  formatInspectionView,
  formatTimelineEntries,
  inspectionRecoveryCommand,
} from "./run-inspection-surface.js";

export type RunFollowOutcome =
  | {
      kind: "closed";
      reason: "subject-terminal" | "awaiting-input" | "paused";
      run: { id: string; status: InspectionView["run"]["status"] };
    }
  | { kind: "detached" }
  | { kind: "error"; error: InspectionError };

export function followExitCode(outcome: RunFollowOutcome): 0 | 1 | 2 {
  if (outcome.kind !== "error") return 0;
  return outcome.error.type === "invalid-query" ? 2 : 1;
}

type FollowOptions = {
  until: "subject-terminal" | "decision-boundary";
  stdout: Writable;
  stderr: Writable;
};

export async function followRun(
  cwd: string,
  view: InspectionViewQuery,
  options: FollowOptions,
): Promise<RunFollowOutcome> {
  const controller = new AbortController();
  let detached = false;
  const onAbort = (): void => {
    detached = true;
    controller.abort();
  };
  process.once("SIGINT", onAbort);

  const iterator = observeInspection(cwd, {
    view,
    until: options.until,
    signal: controller.signal,
  })[Symbol.asyncIterator]();
  const presenter = new InspectionTranscriptPresenter(options.stdout, view.runId);
  let closed: Extract<InspectionObservation, { kind: "closed" }> | undefined;

  try {
    while (!controller.signal.aborted) {
      const next = await iterator.next();
      if (controller.signal.aborted) break;
      if (next.done) break;
      if (next.value.isErr()) {
        writeFollowError(next.value.error, view, options.stderr);
        return { kind: "error", error: next.value.error };
      }
      const observation = next.value.value;
      presenter.observation(observation);
      if (observation.kind === "closed") {
        closed = observation;
        break;
      }
    }
  } catch (error) {
    if (!detached) {
      const failure: InspectionError = {
        type: "read-failed",
        runId: view.runId,
        message: error instanceof Error ? error.message : String(error),
      };
      writeFollowError(failure, view, options.stderr);
      return { kind: "error", error: failure };
    }
  } finally {
    controller.abort();
    process.off("SIGINT", onAbort);
    try {
      await iterator.return?.();
    } catch {
      // Runtime already emits any readable inspection failure.
    }
  }

  if (detached) {
    presenter.block(`Detached from run ${view.runId}. Background daemon continues running.\nInspect: ${inspectionRecoveryCommand(view)}\n`);
    return { kind: "detached" };
  }
  if (closed) {
    return {
      kind: "closed",
      reason: closed.reason,
      run: { id: closed.view.run.id, status: closed.view.run.status },
    };
  }

  const failure: InspectionError = {
    type: "read-failed",
    runId: view.runId,
    message: "Inspection observation ended without a closed view.",
  };
  writeFollowError(failure, view, options.stderr);
  return { kind: "error", error: failure };
}

class InspectionTranscriptPresenter {
  private emitted = false;
  private attachedRun?: { durationMs: number; observedAt: number };

  constructor(
    private readonly stdout: Writable,
    private readonly runId: string,
  ) {}

  observation(observation: InspectionObservation): void {
    if (observation.kind === "attached") {
      if (observation.view.kind === "run" && observation.view.run.durationMs !== undefined) {
        this.attachedRun = {
          durationMs: observation.view.run.durationMs,
          observedAt: Date.now(),
        };
      }
      this.block(`Attached:\n${formatInspectionView(observation.view, { showAwait: false })}`);
      return;
    }
    if (observation.kind === "closed") {
      this.block(formatInspectionView(observation.view));
      return;
    }
    const elapsedMs = this.attachedRun === undefined
      ? undefined
      : Math.max(
          this.attachedRun.durationMs,
          this.attachedRun.durationMs + Date.now() - this.attachedRun.observedAt,
        );
    const blocks = [
      ...(observation.changes.length === 0
        ? []
        : [`Updates${elapsedMs === undefined ? "" : ` · run ${formatDurationMs(elapsedMs)}`}:\n${formatInspectionChanges(observation.changes, this.runId)}`]),
      ...(observation.timeline?.length ? [`Timeline:\n${formatTimelineEntries(observation.timeline)}`] : []),
    ];
    if (blocks.length > 0) this.block(`${blocks.join("\n\n")}\n`);
  }

  block(text: string): void {
    if (this.emitted) this.stdout.write("\n");
    this.stdout.write(text);
    this.emitted = true;
  }
}

function writeFollowError(error: InspectionError, view: InspectionViewQuery, stderr: Writable): void {
  stderr.write(formatInspectionError(error, view));
}
