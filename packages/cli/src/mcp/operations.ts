import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { JsonValue } from "@acpus/expression/ir";
import {
  inspectTargetArtifacts,
  listArtifacts,
  listRuns,
  loadAgentAuthoringContext,
  readArtifact,
  readInspection,
  resolveArtifact,
  resolveAcpusHome,
  tryNormalizeForkInput,
  tryParseAgentInjectionMap,
  type DaemonControlIntent,
} from "@acpus/runtime";
import { tryPrepareWorkflow, type WorkflowSourceInput } from "@acpus/workflow-compiler";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { sendDaemonControl, submitAndObserveStream } from "../daemon/client.js";
import { summarizeWorkflow } from "../presentation/output.js";
import { appliedControl, toRunRecord } from "../runs/record.js";
import { readGuide } from "./guide.js";
export { readGuide };
import { checkWorkflowInvocation } from "../workflow/validation.js";
import { settleMutation } from "./mutation.js";
import { toolFailure, type ToolFailure } from "./result.js";

type WorkflowSource = {
  source?: string | undefined;
  file?: string | undefined;
};

export type WorkflowInput = WorkflowSource & {
  input?: JsonValue | undefined;
  agents?: JsonValue | undefined;
  dryRun?: boolean | undefined;
};

export type ControlAction =
  | { type: "pause" | "resume" }
  | { type: "cancel"; target?: string | undefined }
  | { type: "retry"; target: string }
  | { type: "steer"; target: string; instruction: string }
  | { type: "signal"; target: string; payload: JsonValue }
  | (WorkflowSource & { type: "fork"; target?: string | undefined; input?: JsonValue | undefined; agents?: JsonValue | undefined });

export function agentContext(workspace: string) {
  return loadAgentAuthoringContext({ workspaceDir: workspace }).pipe(
    Effect.map(context => ({ workspace, acpusHome: resolveAcpusHome(), ...context })),
    Effect.mapError(error => toolFailure(error, "Repair Acpus configuration or ACPUS_AUTHORING_AGENT_SCALE, then call acpus_agent.")),
  );
}

function prepare(workspace: string, args: WorkflowSource) {
  const source: WorkflowSourceInput = args.file === undefined
    ? { kind: "files", entry: "workflow.ts", files: [{ path: "workflow.ts", content: args.source! }] }
    : { kind: "path", entry: args.file };
  return tryPrepareWorkflow({ workspaceDir: workspace, source }).pipe(
    Effect.mapError(error => toolFailure(error, "Correct the workflow source and retry the operation.")),
  );
}

export function runWorkflow(workspace: string, args: WorkflowInput) {
  return Effect.gen(function* () {
    const prepared = yield* prepare(workspace, args);
    const input = args.input === undefined && !args.dryRun ? {} : args.input;
    const checked = yield* checkWorkflowInvocation(workspace, prepared, input, args.agents).pipe(
      Effect.mapError(error => toolFailure(error, "Correct input or Agent bindings and call acpus_run.")),
    );
    if (args.dryRun) {
      return { dryRun: true, workflow: summarizeWorkflow(prepared.ir), diagnostics: prepared.ir.diagnostics, unboundAgents: checked.unboundAgents };
    }
    const submitted = submitAndObserveStream(workspace, {
      requestId: `mcp:${randomUUID()}`,
      prepared,
      input: checked.input!,
      ...(checked.agentInjections === undefined ? {} : { agentInjections: checked.agentInjections }),
      until: "admitted",
    }).pipe(
      Stream.filter(frame => frame.kind === "admitted"),
      Stream.runHead,
      Effect.mapError(error => ({
        ...toolFailure(error, "Use acpus_list_runs to locate the run before submitting again; inspect a known runId with acpus_inspect."),
        ...("runId" in error && error.runId !== undefined ? { runId: error.runId } : {}),
      })),
    );
    const admitted = yield* settleMutation(submitted.pipe(Effect.flatMap(frame => Option.isSome(frame)
      ? Effect.succeed(frame.value)
      : Effect.fail({
          code: "ADMISSION_OUTCOME_UNKNOWN", outcome: "unknown", message: "Submission ended before admission was confirmed.",
          next: "Call acpus_list_runs before submitting again.",
        }))));
    return { runId: admitted.run.id, run: toRunRecord(admitted.run), diagnostics: prepared.ir.diagnostics };
  });
}

export function runs(workspace: string, name: string | undefined, offset: number, limit: number) {
  return listRuns(workspace).pipe(
    Effect.map(records => {
      const matching = name === undefined ? records : records.filter(run => run.name === name);
      const nextOffset = offset + limit;
      return { runs: matching.slice(offset, nextOffset), ...(nextOffset < matching.length ? { nextOffset } : {}) };
    }),
    Effect.mapError(error => toolFailure(error, "Run acpus doctor to inspect the workspace store.")),
  );
}

export function controlRun(workspace: string, runId: string, action: ControlAction) {
  return Effect.gen(function* () {
    const base = { requestId: `mcp:${randomUUID()}`, runId };
    let intent: DaemonControlIntent;
    if (action.type === "fork") {
      const prepared = action.source === undefined && action.file === undefined ? undefined : yield* prepare(workspace, action);
      const input = action.input === undefined && prepared === undefined
        ? undefined
        : yield* tryNormalizeForkInput(workspace, runId, action.input, prepared).pipe(
            Effect.mapError(error => toolFailure(error, "Correct the fork input or workflow and retry.")),
          );
      const agentInjections = action.agents === undefined
        ? undefined
        : yield* Effect.fromResult(tryParseAgentInjectionMap(action.agents, prepared?.ir.agents)).pipe(
            Effect.mapError(error => toolFailure(error, "Correct the fork Agent bindings and retry.")),
          );
      intent = {
        ...base, type: "fork",
        ...(action.target === undefined ? {} : { target: action.target }),
        ...(prepared === undefined ? {} : { prepared }),
        ...(input === undefined ? {} : { input }),
        ...(agentInjections === undefined ? {} : { agentInjections }),
      };
    } else if (action.type === "signal") {
      intent = { ...base, type: "signal", nodeId: action.target, payload: action.payload };
    } else if (action.type === "cancel") {
      intent = { ...base, type: "cancel", ...(action.target === undefined ? {} : { target: action.target }) };
    } else {
      intent = { ...base, ...action };
    }
    const controlled = yield* settleMutation(sendDaemonControl(workspace, intent)).pipe(Effect.catch(error => Effect.gen(function* () {
      const target = "target" in action ? action.target : undefined;
      const inspected = target !== undefined && error.cause.type === "rejected" && error.cause.ambiguity
        ? yield* Effect.result(readInspection(workspace, { kind: "target", runId, target, detail: "summary" }))
        : undefined;
      return yield* Effect.fail({
        ...toolFailure(error, "Call acpus_inspect and choose an available action or exact target. If the outcome is unknown, inspect before repeating the action."),
        runId,
        ...(inspected && Result.isSuccess(inspected) && inspected.success.kind === "candidates"
          ? { candidates: inspected.success } : {}),
      });
    })));
    return {
      runId: controlled.run.id,
      run: toRunRecord(controlled.run),
      control: appliedControl(controlled, "target" in action ? action.target : undefined),
    };
  });
}

export type ArtifactAction = { type: "list"; target?: string | undefined } | { type: "read"; id: string };

export function artifact(workspace: string, runId: string, action: ArtifactAction): Effect.Effect<Record<string, unknown>, ToolFailure> {
  return Effect.gen(function* () {
    if (action.type === "list") {
      const artifacts = action.target === undefined
        ? yield* listArtifacts(workspace, runId)
        : (yield* inspectTargetArtifacts(workspace, { runId, target: action.target })).artifacts;
      if (artifacts === undefined) return yield* Effect.fail({ type: "run-not-found", message: `Run '${runId}' was not found.` });
      return { artifacts };
    }
    const verified = yield* resolveArtifact(workspace, `artifact://${runId}/${action.id}`);
    const mediaType = verified.mediaType?.split(";", 1)[0]?.trim();
    if (!(mediaType?.startsWith("text/") || mediaType === "application/json" || mediaType?.endsWith("+json") || mediaType === "application/xml" || mediaType?.endsWith("+xml"))) {
      return { artifact: verified, status: "binary" };
    }
    const read = yield* readArtifact(workspace, runId, action.id);
    if (read === undefined) return yield* Effect.fail({ type: "artifact-not-found", message: `Artifact '${action.id}' was not found.` });
    const truncated = read.bytes.length > 64 * 1024;
    const decoder = new StringDecoder("utf8");
    const content = decoder.write(read.bytes.subarray(0, 64 * 1024)) + (truncated ? "" : decoder.end());
    return { artifact: verified, status: "read", content, truncated };
  }).pipe(Effect.mapError(error => toolFailure(error, "List artifacts with acpus_artifact and select an existing artifact ID or exact target.")));
}
