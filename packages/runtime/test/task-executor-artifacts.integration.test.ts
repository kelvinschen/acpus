import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { err } from "neverthrow";
import type { ArtifactRecord, RegisterArtifactInput } from "../src/store/store.js";
import {
  executeTaskNode,
  inlineTask,
  withTaskExecutorWorkspace,
} from "./support/task-executor-fixture.js";

describe("task executor artifacts", () => {
  it("resolves bound input artifacts to an absolute path that survives process.chdir", async () => {
    await withTaskExecutorWorkspace(async ({ runtimeRunDir, taskOptions }) => {
      const runId = "run_input_path";
      const artifactId = "artifact_input";
      const runDir = runtimeRunDir(runId);
      const path = join(runDir, "artifacts", "input.txt");
      await mkdir(join(runDir, "artifacts"), { recursive: true });
      await writeFile(path, "input\n");
      const ref = {
        kind: "artifact",
        uri: `artifact://${runId}/${artifactId}`,
        mediaType: "text/plain",
      } as const;
      const artifact: ArtifactRecord = {
        id: artifactId,
        runId,
        nodeKey: "produce",
        attempt: 1,
        mediaType: "text/plain",
        digest: "sha256:test",
        size: 6,
        path,
      };
      const node = inlineTask("consume", [
        "async ({ input, artifact }) => {",
        "  const before = artifact.path(input.file);",
        "  process.chdir('/');",
        "  return { before, after: artifact.path(input.file) };",
        "}",
      ].join("\n"), {
        input: {
          file: {
            kind: "object",
            fields: {
              kind: { kind: "literal", value: ref.kind },
              uri: { kind: "literal", value: ref.uri },
              mediaType: { kind: "literal", value: ref.mediaType },
            },
          },
        },
      });
      const options = taskOptions(runId);
      options.store.getArtifact = (_runId, id) => id === artifactId ? artifact : undefined;

      await expect(executeTaskNode(node, {}, options))
        .resolves.toEqual({ before: path, after: path });
    });
  });

  it("rejects an ArtifactRef that was not bound into the Task input", async () => {
    await withTaskExecutorWorkspace(async ({ taskOptions }) => {
      const unbound = inlineTask(
        "unbound",
        "async ({ artifact }) => artifact.path({ kind: 'artifact', uri: 'artifact://run_unbound/artifact_1' })",
      );

      await expect(executeTaskNode(unbound, {}, taskOptions("run_unbound")))
        .rejects.toMatchObject({ failure: { type: "failed" } });
    });
  });

  it("rejects a cross-run ArtifactRef before starting Task code", async () => {
    await withTaskExecutorWorkspace(async ({ taskOptions }) => {
      const foreign = inlineTask("foreign", "async () => ({ ok: true })", {
        input: {
          file: {
            kind: "object",
            fields: {
              kind: { kind: "literal", value: "artifact" },
              uri: { kind: "literal", value: "artifact://run_other/artifact_1" },
            },
          },
        },
      });

      await expect(executeTaskNode(foreign, {}, taskOptions("run_current")))
        .rejects.toMatchObject({
          failure: {
            type: "resolution",
            error: { type: "evaluation", field: "Task node 'foreign' input" },
          },
        });
    });
  });

  it("rejects runtime artifact filesystem failures as system errors", async () => {
    await withTaskExecutorWorkspace(async ({ runtimeRunDir, taskOptions }) => {
      const runId = "run_artifact_filesystem_failure";
      const runDir = runtimeRunDir(runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "artifacts"), "blocks the artifact directory");
      let caught: unknown;

      try {
        await executeTaskNode(
          inlineTask(
            "artifact_filesystem_failure",
            "async ({ artifact }) => artifact.write('result.txt', 'result')",
          ),
          {},
          taskOptions(runId),
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        name: "TaskProcessSystemError",
        code: "ENOTDIR",
      });
      expect(caught).not.toHaveProperty("failure");
    });
  });

  it("rejects artifact writes after scheduler cancellation", async () => {
    await withTaskExecutorWorkspace(async ({ taskOptions }) => {
      const controller = new AbortController();
      const artifacts: RegisterArtifactInput[] = [];
      const node = inlineTask("cancel_artifact", [
        "async ({ artifact, abortSignal }) => {",
        "  await artifact.write('before.txt', 'before');",
        "  if (!abortSignal.aborted) await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true }));",
        "  try {",
        "    await artifact.write('after.txt', 'after');",
        "  } catch {",
        "    return { lateWriteRejected: true };",
        "  }",
        "  return { lateWriteRejected: false };",
        "}",
      ].join("\n"));
      const running = executeTaskNode(node, {}, {
        ...taskOptions("run_cancel_artifact", artifact => {
          artifacts.push(artifact);
          controller.abort();
        }),
        signal: controller.signal,
      });

      await expect(running).rejects.toMatchObject({ failure: { type: "cancelled" } });
      expect(artifacts).toEqual([
        expect.objectContaining({
          relativePath: expect.stringContaining("before.txt"),
          mediaType: "text/plain",
        }),
      ]);
    });
  });

  it("removes an artifact file when the durable attempt fence rejects registration", async () => {
    await withTaskExecutorWorkspace(async ({ runtimeRunDir, taskOptions }) => {
      const node = inlineTask(
        "fenced_artifact",
        "async ({ artifact }) => artifact.write('late.txt', 'late')",
      );
      const options = taskOptions("run_fenced_artifact");
      options.store.registerArtifact = input => err({
        type: "terminal-attempt",
        attemptId: input.attemptId,
        status: "cancelled",
        message: "attempt is already cancelled",
      });

      await expect(executeTaskNode(node, {}, options)).rejects.toMatchObject({
        failure: {
          type: "terminal-attempt",
          attemptId: options.attemptId,
          status: "cancelled",
        },
      });
      const artifactDir = join(
        runtimeRunDir("run_fenced_artifact"),
        "artifacts",
        "fenced_artifact",
        "attempt-1",
      );
      await expect(readdir(artifactDir)).resolves.toEqual([]);
    });
  });
});
