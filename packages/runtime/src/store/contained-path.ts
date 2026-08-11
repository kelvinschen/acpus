import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isContainedPath } from "../path-containment.js";

export class PathEscapeError extends Error {}

export function readContainedFileSync(root: string, relativePath: string): Buffer {
  const rootPath = resolve(root);
  const absolutePath = resolve(rootPath, relativePath);
  if (!isContainedPath(rootPath, absolutePath)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  const info = lstatSync(absolutePath);
  if (info.isSymbolicLink()) throw new PathEscapeError(`Path '${relativePath}' is a symbolic link.`);
  if (!info.isFile()) throw new PathEscapeError(`Path '${relativePath}' is not a file.`);
  const real = realpathSync(absolutePath);
  const realRoot = realpathSync(rootPath);
  if (!isContainedPath(realRoot, real)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  return readFileSync(absolutePath);
}
