import {
  observeInspection,
  readInspection,
  type InspectionViewQuery,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { toolFailure, type ToolFailure } from "./result.js";

export function inspectRun(
  workspace: string,
  query: InspectionViewQuery,
  wait?: "decision" | "terminal",
  timeoutMs = 30_000,
): Effect.Effect<Record<string, unknown>, ToolFailure> {
  return Effect.gen(function* () {
    if (wait === undefined) return { view: yield* readInspection(workspace, query) };
    const view = query.kind === "run" ? query
      : query.detail === "forensics"
        ? yield* Effect.fail({ type: "invalid-query", message: "Forensics cannot be combined with wait." })
        : { ...query, detail: query.detail };
    const closed = yield* observeInspection(workspace, {
      view,
      until: wait === "decision" ? "decision-boundary" : "subject-terminal",
    }).pipe(
      Stream.filter(event => event.kind === "closed"),
      Stream.runHead,
      Effect.timeoutOption(timeoutMs),
    );
    if (Option.isSome(closed) && Option.isSome(closed.value)) {
      return { view: closed.value.value.view, reason: closed.value.value.reason, timedOut: false };
    }
    return { view: yield* readInspection(workspace, query), timedOut: true };
  }).pipe(Effect.mapError(error => toolFailure(error, "Inspect the run or choose an exact target from candidates.")));
}
