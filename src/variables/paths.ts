export type PathRoot = "input" | "outputs" | "loop" | "item" | "run";

export type ParsedSourcePath = {
  root: PathRoot;
  parts: string[];
};

const ROOTS = new Set<PathRoot>(["input", "outputs", "loop", "item", "run"]);
const PART_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function parseSourcePath(source: string): ParsedSourcePath {
  const parts = source.split(".");
  const root = parts.shift();
  if (!root || !ROOTS.has(root as PathRoot)) {
    throw new Error(`Unsupported source root in ${source}`);
  }
  if (parts.some((part) => !PART_PATTERN.test(part))) {
    throw new Error(`Invalid source path segment in ${source}`);
  }
  return { root: root as PathRoot, parts };
}

export function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function toJsonPointer(parts: Array<string | number>): string {
  if (parts.length === 0) return "/";
  return `/${parts.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}
