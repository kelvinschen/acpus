import type { JsonObject } from "../ir/types.js";
import type { ArtifactRef } from "../schema/index.js";
import type { Dollar } from "./dollar.js";

export type ArtifactApi = {
  writeText(name: string, content: string, options?: { mediaType?: string }): Promise<ArtifactRef>;
  writeJson(name: string, value: unknown): Promise<ArtifactRef>;
  writeBytes(name: string, value: Uint8Array, options?: { mediaType?: string }): Promise<ArtifactRef>;
  fromFile(path: string, options?: { name?: string; mediaType?: string }): Promise<ArtifactRef>;
};

export type LogApi = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export type TaskRuntime = {
  runId: string;
  nodeId: string;
  nodeKey: string;
  attempt: number;
  workDir: string;
  outputDir: string;
};

export type TaskContext<Input, Params extends JsonObject = JsonObject> = {
  input: Input;
  params: Params;
  $: Dollar;
  artifact: ArtifactApi;
  log: LogApi;
  env: Record<string, string>;
  runtime: TaskRuntime;
  signal: AbortSignal;
};

export type TaskFunction<Input, Output, Params extends JsonObject = JsonObject> = (ctx: TaskContext<Input, Params>) => Promise<Output> | Output;
