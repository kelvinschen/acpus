import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function developmentExportURL(
  specifier: string,
  parentURL: string,
  dependencyRoot?: string,
): Promise<string | undefined> {
  const parts = packageSpecifierParts(specifier);
  if (!parts) return undefined;
  const packageJson = await findPackageJson(parts.name, dirname(fileURLToPath(parentURL)))
    ?? (dependencyRoot ? await findPackageJson(parts.name, dependencyRoot) : undefined);
  if (!packageJson) return undefined;
  const pkg = JSON.parse(await readFile(packageJson, "utf8")) as { exports?: unknown };
  const entry = exportEntry(pkg.exports, parts.subpath);
  const development = resolveImportTarget(entry, true);
  if (!development?.usedDevelopment) return undefined;
  const normal = resolveImportTarget(entry, false)?.target;
  if (normal && await exists(resolve(dirname(packageJson), normal))) return undefined;
  return pathToFileURL(resolve(dirname(packageJson), development.target)).href;
}

export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".")
    && !specifier.startsWith("/")
    && !specifier.startsWith("file:")
    && !specifier.startsWith("data:")
    && !specifier.startsWith("node:");
}

export function isResolutionError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  return code === "MODULE_NOT_FOUND"
    || code === "ERR_MODULE_NOT_FOUND"
    || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    || code === "ERR_PACKAGE_IMPORT_NOT_DEFINED";
}

async function findPackageJson(name: string, fromDir: string): Promise<string | undefined> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = resolve(current, "node_modules", name, "package.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function packageSpecifierParts(specifier: string): { name: string; subpath: string } | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return undefined;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return undefined;
    return { name: `${parts[0]}/${parts[1]}`, subpath: parts.length > 2 ? `./${parts.slice(2).join("/")}` : "." };
  }
  return { name: parts[0] ?? specifier, subpath: parts.length > 1 ? `./${parts.slice(1).join("/")}` : "." };
}

function exportEntry(exports: unknown, subpath: string): unknown {
  return subpath === "." ? exports : isRecord(exports) ? exports[subpath] : undefined;
}

const nodeImportConditions = new Set(["node-addons", "node", "import", "module-sync"]);

function resolveImportTarget(
  entry: unknown,
  enableDevelopment: boolean,
  usedDevelopment = false,
): { target: string; usedDevelopment: boolean } | undefined {
  if (typeof entry === "string") return { target: entry, usedDevelopment };
  if (Array.isArray(entry)) {
    for (const candidate of entry) {
      const resolved = resolveImportTarget(candidate, enableDevelopment, usedDevelopment);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!isRecord(entry)) return undefined;
  for (const [condition, target] of Object.entries(entry)) {
    if (condition !== "default"
      && !nodeImportConditions.has(condition)
      && !(enableDevelopment && condition === "development")) {
      continue;
    }
    const resolved = resolveImportTarget(
      target,
      enableDevelopment,
      usedDevelopment || condition === "development",
    );
    if (resolved) return resolved;
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
