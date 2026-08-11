import type { JsonValue } from "@acpus/expression/ir";

export type ForkReplayArtifact = {
  id: string;
  nodeKey?: string;
  attempt: number;
  mediaType?: string;
  digest: string;
  size: number;
  relativePath: string;
};

export type ForkReplayFact = {
  nodeKey: string;
  sourceSequence: number;
  operationDigest: string;
  inputDigest: string;
  sessionGroupDigest?: string;
  output?: JsonValue;
  artifacts: ForkReplayArtifact[];
};
