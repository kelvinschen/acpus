import type { RunFileToken } from "../store/run-file.js";

export type RegisterArtifactInput = {
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

export type ArtifactRecord = {
  id: string;
  runId: string;
  nodeKey: string;
  attempt: number;
  mediaType?: string;
  digest: string;
  size: number;
  path: string;
};
