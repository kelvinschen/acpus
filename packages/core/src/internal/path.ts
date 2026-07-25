import { posix, win32 } from "node:path";

export function isRootedPath(path: string): boolean {
  return posix.isAbsolute(path) || win32.parse(path).root.length > 0;
}
