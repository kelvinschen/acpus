import {
  watchInspection,
  type RunInspectionError,
  type RunStatus,
  type WatchInspectionEmission,
  type WatchInspectionQuery,
} from "@acpus/runtime";
import type { Writable } from "node:stream";
import { writeJsonLine } from "./output.js";
import { presentInspectionEmissionJson } from "./run-inspection-json.js";
import { renderShellCommand } from "./shell-command.js";
import {
  formatInspectionCandidates,
  formatRunInspectionDocument,
  formatRunInspectionTimelineEntry,
} from "./run-inspection-surface.js";

export type RunFollowOutcome =
  | { kind: "done"; run: { id: string; status: RunStatus } }
  | { kind: "detached" }
  | { kind: "error"; error: RunInspectionError };

type FollowOptions = {
  phase: "inspect" | "run";
  format: "text" | "ndjson";
  stdout: Writable;
  stderr: Writable;
  /** Workflow-run's private pull cadence; runs inspect deliberately has none. */
  pollIntervalMs?: number;
};

export async function followRun(
  cwd: string,
  query: WatchInspectionQuery,
  options: FollowOptions,
): Promise<RunFollowOutcome> {
  const controller = new AbortController();
  let detached = false;
  const onAbort = (): void => {
    detached = true;
    controller.abort();
  };
  process.once("SIGINT", onAbort);

  const source = watchInspection(cwd, { ...query, signal: controller.signal });
  const iterator = source[Symbol.asyncIterator]();
  const presenter = new RunFollowPresenter(options);
  let lastRun: { id: string; status: RunStatus } | undefined;
  let received = false;

  try {
    while (!controller.signal.aborted) {
      if (received && options.pollIntervalMs !== undefined) {
        await waitForPoll(options.pollIntervalMs, controller.signal);
        if (controller.signal.aborted) break;
      }
      const next = await iterator.next();
      if (next.done) break;
      const result = next.value;
      if (result.isErr()) {
        writeFollowError(result.error, options, query.view);
        return { kind: "error", error: result.error };
      }
      received = true;
      presenter.emission(result.value);
      if (result.value.kind === "view") {
        lastRun = { id: result.value.document.run.id, status: result.value.document.run.status };
      }
    }
  } catch (error) {
    if (detached) {
      // SIGINT is a read-only detach, even when an adapter rejects its pending pull.
    } else {
      const failure: RunInspectionError = {
        type: "inspection-read-failed",
        runId: query.view.runId,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      };
      writeFollowError(failure, options, query.view);
      return { kind: "error", error: failure };
    }
  } finally {
    controller.abort();
    process.off("SIGINT", onAbort);
    try {
      await iterator.return?.();
    } catch {
      // The iterator has already reported any readable failure above.
    }
  }

  if (detached) {
    const stream = options.format === "ndjson" ? options.stderr : options.stdout;
    stream.write(`Detached from run ${query.view.runId}. Background daemon continues running.\n`);
    stream.write(`Inspect: ${renderShellCommand(["acpus", "runs", "inspect", query.view.runId])}\n`);
    return { kind: "detached" };
  }
  if (lastRun) return { kind: "done", run: lastRun };

  const failure: RunInspectionError = {
    type: "inspection-read-failed",
    runId: query.view.runId,
    message: "Run inspection follow ended without a view.",
  };
  writeFollowError(failure, options, query.view);
  return { kind: "error", error: failure };
}

class RunFollowPresenter {
  constructor(private readonly options: FollowOptions) {}

  emission(emission: WatchInspectionEmission): void {
    if (this.options.format === "ndjson") {
      writeJsonLine(this.options.stdout, {
        ok: true,
        phase: this.options.phase,
        ...presentInspectionEmissionJson(emission),
      });
      return;
    }
    this.options.stdout.write(emission.kind === "view"
      ? formatRunInspectionDocument(emission.document)
      : formatRunInspectionTimelineEntry(emission.entry));
  }
}

function writeFollowError(
  error: RunInspectionError,
  options: FollowOptions,
  view: WatchInspectionQuery["view"],
): void {
  if (options.format === "ndjson") {
    writeJsonLine(options.stdout, {
      schemaVersion: 2,
      ok: false,
      phase: options.phase,
      kind: "error",
      error: publicInspectionError(error),
    });
  } else {
    const candidates = error.type === "target-ambiguous"
      ? `${formatInspectionCandidates(error.candidates, followCandidateView(view)).trimEnd()}\n`
      : "";
    options.stderr.write(`${candidates}Inspection failed: ${error.message}\n`);
  }
}

function followCandidateView(view: WatchInspectionQuery["view"]): {
  timeline?: true;
  all?: true;
  controls?: true;
} {
  if (view.kind === "timeline") return { timeline: true };
  if (view.kind !== "target") return {};
  return {
    ...(view.includeAllTopology ? { all: true } : {}),
    ...(view.includeControls ? { controls: true } : {}),
  };
}

function publicInspectionError(error: RunInspectionError): object {
  if (error.type !== "inspection-read-failed") return error;
  return { type: error.type, runId: error.runId, message: error.message };
}

async function waitForPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, intervalMs);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
