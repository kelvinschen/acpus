import type { TaskExecutionTargetIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { RunDirectoryToken } from "../store/path-fence.js";
import type { RunFileToken } from "../store/run-file.js";

export type TaskArtifactRegistration = {
  id: string;
  runId: string;
  nodeKey: string;
  attemptId: string;
  attempt: number;
  ownerEpoch: number;
  mediaType?: string;
  digest: string;
  size: number;
  relativePath: string;
  file: RunFileToken;
};

export type TaskProcessRequest = {
  target: TaskExecutionTargetIR;
  input: Record<string, JsonValue>;
  workspaceDir: string;
  sourceRoot?: string;
  execution?: {
    defaultCommandTimeout?: string;
  };
  artifact: {
    run: RunDirectoryToken;
    nodeKey: string;
    attemptId: string;
    attempt: number;
    ownerEpoch: number;
    paths: Record<string, RunFileToken>;
  };
};

export type TaskProcessParentMessage =
  | { type: "start"; request: TaskProcessRequest }
  | { type: "abort" }
  | { type: "artifact_result"; requestId: string; ok: true }
  | { type: "artifact_result"; requestId: string; ok: false; error: string };

export type TaskProcessChildMessage =
  | { type: "artifact_register"; requestId: string; artifact: TaskArtifactRegistration }
  | { type: "completed"; hasOutput: false }
  | { type: "completed"; hasOutput: true; output: JsonValue }
  | { type: "failed"; message: string }
  | { type: "system_rejected"; error: { message: string; code?: string } };
