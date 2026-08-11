import { Command } from "commander";
import {
  inspectTargetArtifacts,
  listArtifacts,
  resolveArtifact,
  type ArtifactRecord,
  type ArtifactResolutionFailure,
} from "@acpus/runtime";
import { notFoundError, usageError } from "../../errors.js";
import { writeJsonLine } from "../../output.js";
import { jsonOutputFor, withJsonOutput, type JsonOutputOptions } from "../output-option.js";
import type { RunsCommandContext } from "./context.js";

type ArtifactsRunOptions = JsonOutputOptions & {
  target?: string;
};

type ArtifactRunOptions = JsonOutputOptions;

export function createArtifactCommands(ctx: RunsCommandContext): Command[] {
  const artifacts = withJsonOutput(new Command("artifacts")
    .exitOverride()
    .description("List artifact metadata and absolute paths.")
    .argument("<run-id>", "run id")
    .option("--target <run-target>", "list artifacts for one static node, dynamic node, frame, or attempt")
  ).action(async (runId: string, options: ArtifactsRunOptions) => {
    await artifactsRunCommand(ctx, runId, options);
  });

  const artifact = withJsonOutput(new Command("artifact")
    .exitOverride()
    .description("Locate an artifact's verified local source.")
    .argument("<artifact-ref>", "artifact://<run-id>/<artifact-id>")
  ).action(async (artifactRef: string, options: ArtifactRunOptions) => {
    await artifactRunCommand(ctx, artifactRef, options);
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
    const listed = await listArtifacts(ctx.cwd, runId);
    if (listed === undefined) throw notFoundError(`Run '${runId}' was not found.`, { errorCode: "RUN_NOT_FOUND" });
    artifacts = listed;
  } else {
    const inspected = await inspectTargetArtifacts(ctx.cwd, { runId, target: options.target });
    if (inspected.isErr()) throw artifactInspectionError(inspected.error);
    artifacts = inspected.value.artifacts;
  }

  if (jsonOutputFor(options)) {
    writeJsonLine(ctx.stdout, {
      schemaVersion: 1,
      ok: true,
      phase: "inspect",
      runId,
      ...(options.target === undefined ? {} : { target: options.target }),
      artifacts,
    });
  } else if (artifacts.length === 0) {
    ctx.stdout.write("No artifacts.\n");
  } else {
    ctx.stdout.write(`${artifacts.map(artifact => `${artifact.id} ${artifact.mediaType ?? "-"} ${artifact.path}`).join("\n")}\n`);
  }
  ctx.setExitCode(0);
}

async function artifactRunCommand(
  ctx: RunsCommandContext,
  artifactRef: string,
  options: ArtifactRunOptions,
): Promise<void> {
  const resolved = await resolveArtifact(ctx.cwd, artifactRef);
  if (resolved.isErr()) throw artifactResolutionError(resolved.error);
  const artifact = resolved.value;
  if (jsonOutputFor(options)) {
    writeJsonLine(ctx.stdout, {
      schemaVersion: 1,
      ok: true,
      phase: "inspect",
      artifact,
    });
  } else {
    ctx.stdout.write([
      `Path: ${artifact.path}`,
      `Media-Type: ${artifact.mediaType ?? "-"}`,
      `Size: ${artifact.size} bytes`,
      `Digest: ${artifact.digest}`,
      `Source: ${artifact.nodeKey} attempt ${artifact.attempt}`,
      "",
    ].join("\n"));
  }
  ctx.setExitCode(0);
}

function artifactResolutionError(
  error: ArtifactResolutionFailure,
): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (error.type === "invalid-artifact-ref") return usageError(error.message);
  return notFoundError(error.message, { errorCode: error.type.replaceAll("-", "_").toUpperCase() });
}

function artifactInspectionError(
  error: { type: string; message: string },
): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (error.type === "invalid-query") return usageError(error.message);
  return notFoundError(error.message, { errorCode: error.type.replaceAll("-", "_").toUpperCase() });
}
