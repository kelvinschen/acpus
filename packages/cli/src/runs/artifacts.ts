import { Command } from "commander";
import {
  inspectTargetArtifacts,
  listArtifacts,
  resolveArtifact,
  type ArtifactRecord,
  type ArtifactResolutionFailure,
  type RuntimeReadFailure,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { notFoundError, usageError } from "../presentation/errors.js";
import type { RunsCommandContext } from "./context.js";
import { runtimeReadFailureCode, runtimeReadFailureMessage } from "./runtime-read.js";

type ArtifactsRunOptions = {
  target?: string;
};

export function createArtifactCommands(ctx: RunsCommandContext): Command[] {
  const artifacts = new Command("artifacts")
    .exitOverride()
    .description("List artifact metadata and absolute paths.")
    .argument("<run-id>", "run id")
    .option("--target <run-target>", "list artifacts for one static node, dynamic node, frame, or attempt")
    .action(async (runId: string, options: ArtifactsRunOptions) => {
      await artifactsRunCommand(ctx, runId, options);
    });

  const artifact = new Command("artifact")
    .exitOverride()
    .description("Locate an artifact's verified local source.")
    .argument("<artifact-ref>", "artifact://<run-id>/<artifact-id>")
    .action(async (artifactRef: string) => {
      await artifactRunCommand(ctx, artifactRef);
    });

  return [artifacts, artifact];
}

async function artifactsRunCommand(
  ctx: RunsCommandContext,
  runId: string,
  options: ArtifactsRunOptions,
): Promise<void> {
  if (options.target === "") throw usageError("--target must be a non-empty string.");
  let artifacts: ArtifactRecord[];
  if (options.target === undefined) {
    const listed = await Effect.runPromise(Effect.result(listArtifacts(ctx.cwd, runId)));
    if (Result.isFailure(listed)) throw runtimeReadError(listed.failure);
    if (listed.success === undefined) throw notFoundError(`Run '${runId}' was not found.`, { errorCode: "RUN_NOT_FOUND" });
    artifacts = listed.success;
  } else {
    const inspected = await Effect.runPromise(Effect.result(
      inspectTargetArtifacts(ctx.cwd, { runId, target: options.target }),
    ));
    if (Result.isFailure(inspected)) throw artifactInspectionError(inspected.failure);
    artifacts = inspected.success.artifacts;
  }

  if (artifacts.length === 0) {
    ctx.stdout.write("No artifacts.\n");
  } else {
    ctx.stdout.write(`${artifacts.map(artifact => `${artifact.id} ${artifact.mediaType ?? "-"} ${artifact.path}`).join("\n")}\n`);
  }
  ctx.setExitCode(0);
}

async function artifactRunCommand(
  ctx: RunsCommandContext,
  artifactRef: string,
): Promise<void> {
  const resolved = await Effect.runPromise(Effect.result(resolveArtifact(ctx.cwd, artifactRef)));
  if (Result.isFailure(resolved)) throw artifactResolutionError(resolved.failure);
  const artifact = resolved.success;
  ctx.stdout.write([
    `Path: ${artifact.path}`,
    `Media-Type: ${artifact.mediaType ?? "-"}`,
    `Size: ${artifact.size} bytes`,
    `Digest: ${artifact.digest}`,
    `Source: ${artifact.nodeKey.replace(/~[0-9a-f]{8}$/, "")} attempt ${artifact.attempt}`,
    "",
  ].join("\n"));
  ctx.setExitCode(0);
}

function artifactResolutionError(
  error: ArtifactResolutionFailure | RuntimeReadFailure,
): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (isRuntimeReadFailure(error)) return runtimeReadError(error);
  if (error.type === "invalid-artifact-ref") return usageError(error.message);
  return notFoundError(error.message, { errorCode: error.type.replaceAll("-", "_").toUpperCase() });
}

function runtimeReadError(error: RuntimeReadFailure): ReturnType<typeof notFoundError> {
  return notFoundError(runtimeReadFailureMessage(error), { errorCode: runtimeReadFailureCode(error) });
}

function isRuntimeReadFailure(error: ArtifactResolutionFailure | RuntimeReadFailure): error is RuntimeReadFailure {
  return error.type.startsWith("runtime-store-");
}

function artifactInspectionError(
  error: { type: string; message: string },
): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (error.type === "invalid-query") return usageError(error.message);
  return notFoundError(error.message, { errorCode: error.type.replaceAll("-", "_").toUpperCase() });
}
