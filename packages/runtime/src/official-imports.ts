import { existsSync } from "node:fs";
import { createRequire, register } from "node:module";
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

let registered = false;
const require = createRequire(import.meta.url);

export function officialAuthoringImportURL(specifier: string): string | undefined {
  const target = (officialTargets as Record<string, ImplementationSpecifier | undefined>)[specifier];
  if (!target) return undefined;
  const source = sourceURL(target);
  return source ?? import.meta.resolve(target);
}

export function registerOfficialAuthoringImports(): void {
  if (registered) return;
  registered = true;
  const entries = Object.keys(officialTargets).map(specifier => [specifier, officialAuthoringImportURL(specifier)] as const);
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

function sourceURL(target: ImplementationSpecifier): string | undefined {
  const candidate = new URL(sourceTargets[target], import.meta.url);
  return existsSync(fileURLToPath(candidate)) ? candidate.href : undefined;
}

function registerCommonJSResolver(imports: Map<string, string | undefined>): void {
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
