import type { Dollar } from "./dollar.js";

export type ArtifactRef = {
  readonly kind: "artifact";
  readonly uri: string;
  readonly mediaType?: string;
};

type ArtifactApi = {
  write(name: string, content: string | Uint8Array, options?: { mediaType?: string }): Promise<ArtifactRef>;
  path(ref: ArtifactRef): string;
};

export type TaskContext<Input> = {
  input: Input;
  $: Dollar;
  artifact: ArtifactApi;
  env: Record<string, string | undefined>;
  abortSignal: AbortSignal;
};

export type TaskFunction<Input, Output> = (ctx: TaskContext<Input>) => Promise<Output> | Output;
