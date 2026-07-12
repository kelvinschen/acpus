import { existsSync, readFileSync, realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register as registerTsx, tsImport } from "tsx/esm/api";

const officialTargets = {
  "acpus/core": "@acpus/core",
  "acpus/expression": "@acpus/expression",
  "acpus/tasks/git": "@acpus/tasks/git",
} as const;

const sourceTargets: Record<ImplementationSpecifier, string> = {
  "@acpus/core": "../../core/src/index.ts",
  "@acpus/expression": "../../expression/src/index.ts",
  "@acpus/tasks/git": "../../tasks/src/git.ts",
};

type OfficialSpecifier = keyof typeof officialTargets;
type ImplementationSpecifier = typeof officialTargets[OfficialSpecifier];

export type OfficialAuthoringEnvironment = {
  imports: Record<OfficialSpecifier, {
    package: string;
    version: string;
    packageRoot: string;
    typesPath: string;
  }>;
};

type OfficialTypeScriptPaths = {
  paths: Record<string, string[]>;
  usesSource: boolean;
};

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

export function officialAuthoringTypeScriptPaths(fromDir: string): OfficialTypeScriptPaths {
  const paths: Record<string, string[]> = {};
  let usesSource = false;
  for (const specifier of Object.keys(officialTargets)) {
    const resolved = resolveOfficialImport(specifier);
    paths[specifier] = [configRelative(fromDir, typecheckImportPath(resolved))];
    usesSource ||= resolved.usesSource;
  }
  return { paths, usesSource };
}

export function officialAuthoringEnvironment(): OfficialAuthoringEnvironment {
  return {
    imports: Object.fromEntries(Object.entries(officialTargets).map(([specifier, target]) => {
      const resolved = resolveOfficialImport(specifier as OfficialSpecifier);
      const typesPath = realpathSync(typecheckImportPath(resolved));
      const packageName = packageSpecifierParts(target)?.name;
      if (!packageName) throw new Error(`Invalid Acpus authoring package specifier '${target}'.`);
      const packageRoot = implementationPackageRoot(typesPath, packageName);
      const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { version?: unknown };
      if (typeof manifest.version !== "string" || manifest.version.length === 0) {
        throw new Error(`Resolved Acpus authoring package '${target}' has no version.`);
      }
      return [specifier, { package: packageName, version: manifest.version, packageRoot, typesPath }];
    })) as OfficialAuthoringEnvironment["imports"],
  };
}

function registerAuthoringModuleLoader(): void {
  if (registered) return;
  registered = true;
  const entries = Object.keys(officialTargets).map(specifier => [specifier, resolveOfficialImport(specifier).url] as const);
  const imports = new Map(entries);
  registerTsx();
  registerCommonJSResolver(imports);
  registerSyncResolveHook(imports);
  registerEsmResolveLoader(entries);
}

export async function importAuthoringModule(specifier: string, options: { parentURL: string }): Promise<Record<string, unknown>> {
  registerAuthoringModuleLoader();
  const officialURL = officialAuthoringImportURL(specifier);
  if (officialURL) return normalizeModule(await import(officialURL) as Record<string, unknown>);
  const developmentURL = await developmentExportURL(specifier, options.parentURL);
  try {
    return await importDefaultTarget(specifier, options.parentURL);
  } catch (error) {
    if (!developmentURL || !isResolutionError(error)) throw error;
    return normalizeModule(await tsImport(developmentURL, { parentURL: options.parentURL }) as Record<string, unknown>);
  }
}

function officialAuthoringImportURL(specifier: string): string | undefined {
  const target = (officialTargets as Record<string, ImplementationSpecifier | undefined>)[specifier];
  if (!target) return undefined;
  return sourceURL(target) ?? import.meta.resolve(target);
}

function resolveOfficialImport(specifier: string): { url: string; usesSource: boolean } {
  const target = (officialTargets as Record<string, ImplementationSpecifier | undefined>)[specifier];
  if (!target) throw new Error(`Unsupported Acpus authoring import '${specifier}'.`);
  const source = sourceURL(target);
  return source ? { url: source, usesSource: true } : { url: import.meta.resolve(target), usesSource: false };
}

function sourceURL(target: ImplementationSpecifier): string | undefined {
  const candidate = new URL(sourceTargets[target], import.meta.url);
  return existsSync(fileURLToPath(candidate)) ? candidate.href : undefined;
}

function typecheckImportPath(resolved: { url: string; usesSource: boolean }): string {
  const path = fileURLToPath(resolved.url);
  if (resolved.usesSource || !path.endsWith(".js")) return path;
  const declarations = `${path.slice(0, -3)}.d.ts`;
  return existsSync(declarations) ? declarations : path;
}

function implementationPackageRoot(entry: string, expectedName: string): string {
  let current = dirname(entry);
  while (true) {
    const manifestPath = resolve(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (manifest.name === expectedName) return realpathSync(current);
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not find package root for Acpus authoring package '${expectedName}'.`);
    current = parent;
  }
}

function configRelative(fromDir: string, to: string): string {
  const path = relative(fromDir, to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

function registerCommonJSResolver(imports: Map<string, string>): void {
  const moduleBuiltin = require("node:module") as ModuleBuiltin;
  const original = moduleBuiltin._resolveFilename;
  moduleBuiltin._resolveFilename = function resolveAcpusAuthoringImport(this: unknown, request: string, parent: unknown, isMain: boolean, options?: unknown): string {
    const url = imports.get(request);
    if (url) return fileURLToPath(url);
    return original.call(this, request, parent, isMain, options);
  };
}

function registerSyncResolveHook(imports: Map<string, string>): void {
  const moduleBuiltin = require("node:module") as ModuleBuiltin;
  if (typeof moduleBuiltin.registerHooks !== "function") return;
  moduleBuiltin.registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = imports.get(specifier);
      if (url) return { url, shortCircuit: true };
      return nextResolve(specifier, context);
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

async function importDefaultTarget(specifier: string, parentURL: string): Promise<Record<string, unknown>> {
  const mod = isBareSpecifier(specifier)
    ? await tsImport(specifier, { parentURL }) as Record<string, unknown>
    : await import(moduleURL(specifier, parentURL)) as Record<string, unknown>;
  return normalizeModule(mod);
}

function moduleURL(specifier: string, parentURL: string): string {
  if (specifier.startsWith("file:") || specifier.startsWith("data:") || specifier.startsWith("node:")) return specifier;
  if (specifier.startsWith(".")) return new URL(specifier, parentURL).href;
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  return specifier;
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".")
    && !specifier.startsWith("/")
    && !specifier.startsWith("file:")
    && !specifier.startsWith("data:")
    && !specifier.startsWith("node:");
}

async function developmentExportURL(specifier: string, parentURL: string): Promise<string | undefined> {
  const parts = packageSpecifierParts(specifier);
  if (!parts) return undefined;
  const packageJson = await findPackageJson(parts.name, dirname(fileURLToPath(parentURL)));
  if (!packageJson) return undefined;
  const pkg = JSON.parse(await readFile(packageJson, "utf8")) as { exports?: unknown };
  const entry = exportEntry(pkg.exports, parts.subpath);
  const development = conditionTarget(entry, "development");
  if (!development) return undefined;
  const normal = normalImportTarget(entry);
  if (normal && await exists(resolve(dirname(packageJson), normal))) return undefined;
  return pathToFileURL(resolve(dirname(packageJson), development)).href;
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

async function findPackageJson(name: string, fromDir: string): Promise<string | undefined> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = resolve(current, "node_modules", name, "package.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function exportEntry(exports: unknown, subpath: string): unknown {
  return subpath === "." ? exports : isRecord(exports) ? exports[subpath] : undefined;
}

function normalImportTarget(entry: unknown): string | undefined {
  return conditionTarget(entry, "node") ?? conditionTarget(entry, "import") ?? conditionTarget(entry, "default");
}

function conditionTarget(entry: unknown, condition: string): string | undefined {
  if (typeof entry === "string") return condition === "default" ? entry : undefined;
  if (!isRecord(entry)) return undefined;
  const target = entry[condition];
  if (typeof target === "string") return target;
  if (isRecord(target) && typeof target.default === "string") return target.default;
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isResolutionError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  return code === "MODULE_NOT_FOUND"
    || code === "ERR_MODULE_NOT_FOUND"
    || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    || code === "ERR_PACKAGE_IMPORT_NOT_DEFINED"
    || code === "ERR_UNSUPPORTED_DIR_IMPORT";
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
