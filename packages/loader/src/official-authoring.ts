import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const implementationPackageNames: Record<ImplementationSpecifier, string> = {
  "@acpus/core": "@acpus/core",
  "@acpus/expression": "@acpus/expression",
  "@acpus/tasks/git": "@acpus/tasks",
};

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
      const packageName = implementationPackageNames[target];
      const packageRoot = implementationPackageRoot(typesPath, packageName);
      const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { version?: unknown };
      if (typeof manifest.version !== "string" || manifest.version.length === 0) {
        throw new Error(`Resolved Acpus authoring package '${target}' has no version.`);
      }
      return [specifier, { package: packageName, version: manifest.version, packageRoot, typesPath }];
    })) as OfficialAuthoringEnvironment["imports"],
  };
}

export function officialAuthoringImportURL(specifier: string): string | undefined {
  const target = (officialTargets as Record<string, ImplementationSpecifier | undefined>)[specifier];
  if (!target) return undefined;
  return sourceURL(target) ?? import.meta.resolve(target);
}

export function officialAuthoringImportEntries(): readonly (readonly [string, string])[] {
  return Object.keys(officialTargets).map(specifier => [specifier, resolveOfficialImport(specifier).url] as const);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
