import type { Dollar } from "./dollar.js";

export type ArtifactRef = {
  readonly kind: "artifact";
  readonly uri: string;
  readonly mediaType?: string;
};

type ArtifactApi = {
  writeText(name: string, content: string, options?: { mediaType?: string }): Promise<ArtifactRef>;
  writeJson(name: string, value: unknown): Promise<ArtifactRef>;
  writeBytes(name: string, value: Uint8Array, options?: { mediaType?: string }): Promise<ArtifactRef>;
  fromFile(path: string, options?: { name?: string; mediaType?: string }): Promise<ArtifactRef>;
};

export type TaskContext<Input> = {
  input: Input;
  $: Dollar;
  artifact: ArtifactApi;
  env: Record<string, string | undefined>;
  abortSignal: AbortSignal;
};

export type TaskFunction<Input, Output> = (ctx: TaskContext<Input>) => Promise<Output> | Output;
