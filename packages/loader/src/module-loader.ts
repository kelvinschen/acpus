import { access, readFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register as registerTsx, tsImport } from "tsx/esm/api";
import { dependencyAuthority, dependencyParentURL, registerDependencyAuthority } from "./dependency-authority.js";
import { officialAuthoringImportEntries, officialAuthoringImportURL } from "./official-authoring.js";
import { developmentExportURL, isBareSpecifier, isResolutionError } from "./package-resolution.js";

type ModuleBuiltin = typeof import("node:module") & {
  _resolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string;
  registerHooks?: (hooks: {
    resolve(
      specifier: string,
      context: unknown,
      nextResolve: (specifier: string, context: unknown) => unknown,
    ): unknown;
  }) => void;
};

let registered = false;
const require = createRequire(import.meta.url);

export async function importAuthoringModule(
  specifier: string,
  options: { parentURL: string; sourceRoot?: string; dependencyRoot?: string },
): Promise<Record<string, unknown>> {
  registerDependencyAuthority(options);
  registerAuthoringModuleLoader();
  const officialURL = officialAuthoringImportURL(specifier);
  if (officialURL) return normalizeModule(await import(officialURL) as Record<string, unknown>);
  const developmentURL = await developmentExportURL(specifier, options.parentURL, options.dependencyRoot);
  try {
    return await importDefaultTarget(specifier, options.parentURL, options.dependencyRoot);
  } catch (error) {
    if (!developmentURL || !isResolutionError(error)) throw error;
    return normalizeModule(await tsImport(developmentURL, { parentURL: options.parentURL }) as Record<string, unknown>);
  }
}

function registerAuthoringModuleLoader(): void {
  if (registered) return;
  registered = true;
  const entries = officialAuthoringImportEntries();
  const imports = new Map(entries);
  registerTsx();
  registerCommonJSResolver(imports);
  registerSyncResolveHook(imports);
  registerEsmResolveLoader(entries);
}

function registerCommonJSResolver(imports: Map<string, string>): void {
  const moduleBuiltin = require("node:module") as ModuleBuiltin;
  const original = moduleBuiltin._resolveFilename;
  moduleBuiltin._resolveFilename = function resolveAcpusAuthoringImport(this: unknown, request: string, parent: unknown, isMain: boolean, options?: unknown): string {
    const url = imports.get(request);
    if (url) return fileURLToPath(url);
    try {
      return original.call(this, request, parent, isMain, options);
    } catch (error) {
      const parentPath = isRecord(parent) && typeof parent.filename === "string" ? parent.filename : undefined;
      const authority = parentPath ? dependencyAuthority(pathToFileURL(parentPath).href) : undefined;
      if (!authority || !isBareSpecifier(request) || !isResolutionError(error)) throw error;
      return createRequire(authority.dependencyParentURL).resolve(request);
    }
  };
}

function registerSyncResolveHook(imports: Map<string, string>): void {
  const moduleBuiltin = require("node:module") as ModuleBuiltin;
  if (typeof moduleBuiltin.registerHooks !== "function") return;
  moduleBuiltin.registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = imports.get(specifier);
      if (url) return { url, shortCircuit: true };
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const parentURL = isRecord(context) && typeof context.parentURL === "string" ? context.parentURL : undefined;
        const authority = parentURL ? dependencyAuthority(parentURL) : undefined;
        if (!authority || !isBareSpecifier(specifier) || !isResolutionError(error)) throw error;
        return nextResolve(specifier, {
          ...(context as unknown as Record<string, unknown>),
          parentURL: authority.dependencyParentURL,
        });
      }
    },
  });
}

function registerEsmResolveLoader(entries: readonly (readonly [string, string])[]): void {
  const loader = `
const officialImports = new Map(${JSON.stringify(entries)});
export async function resolve(specifier, context, nextResolve) {
  const url = officialImports.get(specifier);
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
  register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);
}

async function importDefaultTarget(
  specifier: string,
  parentURL: string,
  dependencyRoot?: string,
): Promise<Record<string, unknown>> {
  const commonJsPath = await commonJsAuthoringPath(specifier, parentURL);
  if (commonJsPath) return normalizeModule(createRequire(parentURL)(commonJsPath) as Record<string, unknown>);
  let mod: Record<string, unknown>;
  try {
    mod = isBareSpecifier(specifier)
      ? await tsImport(specifier, { parentURL }) as Record<string, unknown>
      : await import(moduleURL(specifier, parentURL)) as Record<string, unknown>;
  } catch (error) {
    if (!dependencyRoot || !isBareSpecifier(specifier) || !isResolutionError(error)) throw error;
    mod = await tsImport(specifier, { parentURL: dependencyParentURL(dependencyRoot) }) as Record<string, unknown>;
  }
  return normalizeModule(mod);
}

async function commonJsAuthoringPath(specifier: string, parentURL: string): Promise<string | undefined> {
  if (isBareSpecifier(specifier) || specifier.startsWith("data:") || specifier.startsWith("node:")) return undefined;
  const url = moduleURL(specifier, parentURL);
  if (!url.startsWith("file:")) return undefined;
  let path = fileURLToPath(url);
  const extension = extname(path);
  if (extension === ".mjs" || extension === ".mts") return undefined;
  if (extension === ".cjs" || extension === ".cts") return path;
  if (!/\.[jt]sx?$/.test(extension)) return undefined;
  if (extension === ".js" && !await exists(path)) {
    const sourcePath = `${path.slice(0, -extension.length)}.ts`;
    if (await exists(sourcePath)) path = sourcePath;
  }
  const packageJson = await findNearestPackageJson(dirname(path));
  if (!packageJson) return path;
  const pkg = JSON.parse(await readFile(packageJson, "utf8")) as { type?: unknown };
  return pkg.type === "module" ? undefined : path;
}

function moduleURL(specifier: string, parentURL: string): string {
  if (specifier.startsWith("file:") || specifier.startsWith("data:") || specifier.startsWith("node:")) return specifier;
  if (specifier.startsWith(".")) return new URL(specifier, parentURL).href;
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  return specifier;
}

async function findNearestPackageJson(fromDir: string): Promise<string | undefined> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = resolve(current, "package.json");
    if (await exists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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

function normalizeModule(mod: Record<string, unknown>): Record<string, unknown> {
  if (!("module.exports" in mod) || !isRecord(mod.default)) return mod;
  return {
    ...mod.default,
    default: "default" in mod.default ? mod.default.default : mod.default,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
