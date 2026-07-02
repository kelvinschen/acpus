import { existsSync } from "node:fs";
import { createRequire, register } from "node:module";
import { relative } from "node:path";
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

export type OfficialTypeScriptPaths = {
  paths: Record<string, string[]>;
  usesSource: boolean;
};

let registered = false;
const require = createRequire(import.meta.url);

export function officialAuthoringTarget(specifier: string): ImplementationSpecifier | undefined {
  return (officialTargets as Record<string, ImplementationSpecifier | undefined>)[specifier];
}

export function officialAuthoringTypeScriptPaths(fromDir: string): OfficialTypeScriptPaths {
  const paths: Record<string, string[]> = {};
  let usesSource = false;
  for (const specifier of Object.keys(officialTargets)) {
    const resolved = resolveOfficialImport(specifier);
    paths[specifier] = [configRelative(fromDir, fileURLToPath(resolved.url))];
    usesSource ||= resolved.usesSource;
  }
  return { paths, usesSource };
}

export function registerOfficialAuthoringImports(): void {
  if (registered) return;
  registered = true;
  const entries = Object.keys(officialTargets).map(specifier => [specifier, resolveOfficialImport(specifier).url] as const);
  registerCommonJSResolver(new Map(entries));
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

function resolveOfficialImport(specifier: string): { url: string; usesSource: boolean } {
  const target = officialAuthoringTarget(specifier);
  if (!target) throw new Error(`Unsupported Acpus authoring import '${specifier}'.`);
  const source = sourceURL(target);
  return source ? { url: source, usesSource: true } : { url: import.meta.resolve(target), usesSource: false };
}

function sourceURL(target: ImplementationSpecifier): string | undefined {
  const candidate = new URL(sourceTargets[target], import.meta.url);
  return existsSync(fileURLToPath(candidate)) ? candidate.href : undefined;
}

function configRelative(fromDir: string, to: string): string {
  const path = relative(fromDir, to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

function registerCommonJSResolver(imports: Map<string, string>): void {
  const moduleBuiltin = require("node:module") as {
    _resolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string;
  };
  const original = moduleBuiltin._resolveFilename;
  moduleBuiltin._resolveFilename = function resolveAcpusAuthoringImport(this: unknown, request: string, parent: unknown, isMain: boolean, options?: unknown): string {
    const url = imports.get(request);
    if (url) return fileURLToPath(url);
    return original.call(this, request, parent, isMain, options);
  };
}
