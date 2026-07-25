import { readFileSync, realpathSync, statSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const dependencyAuthorities = new Map<string, string>();

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
  return pathExistsSync(fileURLToPath(candidate)) ? candidate.href : undefined;
}

function typecheckImportPath(resolved: { url: string; usesSource: boolean }): string {
  const path = fileURLToPath(resolved.url);
  if (resolved.usesSource || !path.endsWith(".js")) return path;
  const declarations = `${path.slice(0, -3)}.d.ts`;
  return pathExistsSync(declarations) ? declarations : path;
}

function implementationPackageRoot(entry: string, expectedName: string): string {
  let current = dirname(entry);
  while (true) {
    const manifestPath = resolve(current, "package.json");
    if (pathExistsSync(manifestPath)) {
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

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".")
    && !specifier.startsWith("/")
    && !specifier.startsWith("file:")
    && !specifier.startsWith("data:")
    && !specifier.startsWith("node:");
}

async function developmentExportURL(
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
  const normal = normalImportTarget(entry);
  if (normal && await exists(resolve(dirname(packageJson), normal))) return undefined;
  return pathToFileURL(resolve(dirname(packageJson), development.target)).href;
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
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
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

function exportEntry(exports: unknown, subpath: string): unknown {
  return subpath === "." ? exports : isRecord(exports) ? exports[subpath] : undefined;
}

function normalImportTarget(entry: unknown): string | undefined {
  return resolveImportTarget(entry, false)?.target;
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

function pathExistsSync(path: string): boolean {
  try {
    statSync(path);
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

function isResolutionError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  return code === "MODULE_NOT_FOUND"
    || code === "ERR_MODULE_NOT_FOUND"
    || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    || code === "ERR_PACKAGE_IMPORT_NOT_DEFINED";
}

function registerDependencyAuthority(options: {
  parentURL: string;
  sourceRoot?: string;
  dependencyRoot?: string;
}): void {
  if (!options.dependencyRoot || !options.parentURL.startsWith("file:")) return;
  const sourceRoot = canonicalPath(options.sourceRoot ?? dirname(fileURLToPath(options.parentURL)));
  dependencyAuthorities.set(sourceRoot, dependencyParentURL(options.dependencyRoot));
}

function dependencyAuthority(parentURL: string): { sourceRoot: string; dependencyParentURL: string } | undefined {
  if (!parentURL.startsWith("file:")) return undefined;
  const parentPath = canonicalPath(fileURLToPath(parentURL));
  let closest: { sourceRoot: string; dependencyParentURL: string } | undefined;
  for (const [sourceRoot, dependencyParentURL] of dependencyAuthorities) {
    if (isContainedPath(sourceRoot, parentPath) && (!closest || sourceRoot.length > closest.sourceRoot.length)) {
      closest = { sourceRoot, dependencyParentURL };
    }
  }
  return closest;
}

function dependencyParentURL(root: string): string {
  return pathToFileURL(join(canonicalPath(root), "__acpus_dependency_authority__.mjs")).href;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return resolve(path);
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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
