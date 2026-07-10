import type { TaskExecutionTargetIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";

export type TaskArtifactRegistration = {
  id: string;
  runId: string;
  nodeKey: string;
  attempt: number;
  mediaType?: string;
  digest: string;
  size: number;
  relativePath: string;
};

export type TaskProcessRequest = {
  target: TaskExecutionTargetIR;
  input: Record<string, JsonValue>;
  workspaceDir: string;
  execution?: {
    shell?: "bash" | "powershell" | "pwsh";
    defaultCommandTimeout?: string;
    commandRunner?: "acpus-zx-core" | "custom";
  };
  artifact: {
    runId: string;
    nodeKey: string;
    attempt: number;
    runDir: string;
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
  | { type: "failed"; error: { name: string; message: string; stack?: string } };
