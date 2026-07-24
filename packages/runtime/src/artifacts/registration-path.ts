import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolveArtifactRegistrationPath(input: {
  runDir: string;
  nodeKey: unknown;
  attempt: unknown;
  relativePath: unknown;
}): string | undefined {
  if (
    typeof input.nodeKey !== "string"
    || !Number.isInteger(input.attempt)
    || Number(input.attempt) < 1
    || typeof input.relativePath !== "string"
    || isAbsolute(input.relativePath)
  ) {
    return undefined;
  }
  const runDir = resolve(input.runDir);
  const artifactsRoot = resolve(runDir, "artifacts");
  const attemptRoot = resolve(artifactsRoot, input.nodeKey, `attempt-${String(input.attempt)}`);
  const artifactPath = resolve(runDir, input.relativePath);
  if (
    !isContainedPath(artifactsRoot, attemptRoot)
    || attemptRoot === artifactPath
    || !isContainedPath(attemptRoot, artifactPath)
  ) {
    return undefined;
  }
  return artifactPath;
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
