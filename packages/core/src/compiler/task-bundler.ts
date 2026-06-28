import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { build } from "esbuild";
import type { DiagnosticIR, TaskBundleIR, WorkflowIR } from "../ir/types.js";
import { forEachTaskNode } from "./ir-walk.js";
import type { AnalyzedTask, WorkflowTaskAnalysis } from "./task-provenance.js";

export type BundleTaskOptions = {
  cwd: string;
  conditions?: string[];
  analysis: WorkflowTaskAnalysis;
};

export async function bundleWorkflowTasks(ir: WorkflowIR, options: BundleTaskOptions): Promise<void> {
  const byBundle = analysisByBundleId(ir, options.analysis);
  for (const bundle of Object.values(ir.assets.taskBundles)) {
    const analyzed = byBundle.get(bundle.id);
    if (analyzed?.error) {
      ir.diagnostics.push({
        code: analyzed.error.code,
        severity: "error",
        message: analyzed.error.message,
        path: `assets.taskBundles.${bundle.id}${analyzed.error.pathSuffix}`,
      });
      continue;
    }
    const result = await bundleTask(bundle, analyzed, options);
    if (!result.ok) {
      ir.diagnostics.push(result.diagnostic);
      continue;
    }
    bundle.source = result.source;
    if (analyzed?.sourceFile) bundle.sourceFile = analyzed.sourceFile;
    bundle.digest = digest(result.source);
  }
  syncTaskRunDigests(ir);
  ir.lock.taskBundleDigests = Object.fromEntries(
    Object.entries(ir.assets.taskBundles).map(([id, bundle]) => [id, bundle.digest]),
  );
}

function analysisByBundleId(ir: WorkflowIR, analysis: WorkflowTaskAnalysis): Map<string, AnalyzedTask> {
  const byBundle = new Map<string, AnalyzedTask>();
  forEachTaskNode(ir.root, node => {
    const analyzed = analysis.get(node.id);
    if (!analyzed) return;
    // Distinct callsites can share a bundle id (identical task source). The
    // bundle is admissible only if every callsite is, so an errored verdict
    // wins regardless of node walk order.
    const existing = byBundle.get(node.run.bundleId);
    if (!existing || (analyzed.error && !existing.error)) byBundle.set(node.run.bundleId, analyzed);
  });
  return byBundle;
}

type BundleResult =
  | { ok: true; source: string }
  | { ok: false; diagnostic: DiagnosticIR };

async function bundleTask(bundle: TaskBundleIR, analyzed: AnalyzedTask | undefined, options: BundleTaskOptions): Promise<BundleResult> {
  if (bundle.inline) {
    if (!bundle.source) return bundleError(bundle, "TB002", "is missing source for bundling.", ".source");
    return bundleSource({ bundle, contents: `export default ${bundle.source};\n`, resolveDir: options.cwd, options });
  }
  const sourceFile = analyzed?.sourceFile;
  if (!sourceFile) return bundleError(bundle, "TB001", "is missing statically resolved source file metadata.", ".sourceFile");
  return bundleSource({
    bundle,
    contents: `import token from ${JSON.stringify(sourceFile)};\nexport default token.fn;\n`,
    resolveDir: dirname(sourceFile),
    options,
  });
}

async function bundleSource(args: {
  bundle: TaskBundleIR;
  contents: string;
  resolveDir: string;
  options: BundleTaskOptions;
}): Promise<BundleResult> {
  try {
    const result = await build({
      stdin: {
        contents: args.contents,
        loader: "ts",
        resolveDir: args.resolveDir,
        sourcefile: `${args.bundle.id}.entry.ts`,
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: "node22",
      ...(args.options.conditions ? { conditions: args.options.conditions } : {}),
      logLevel: "silent",
    });
    const output = result.outputFiles?.[0]?.text;
    if (!output) throw new Error("esbuild produced no output file.");
    return { ok: true, source: output };
  } catch (error) {
    return bundleError(args.bundle, "TB003", `failed to bundle: ${error instanceof Error ? error.message : String(error)}`, "");
  }
}

function bundleError(bundle: TaskBundleIR, code: string, suffix: string, pathSuffix: string): { ok: false; diagnostic: DiagnosticIR } {
  return {
    ok: false,
    diagnostic: {
      code,
      severity: "error",
      message: `Task bundle '${bundle.id}' ${suffix}`,
      path: `assets.taskBundles.${bundle.id}${pathSuffix}`,
    },
  };
}

function syncTaskRunDigests(ir: WorkflowIR): void {
  forEachTaskNode(ir.root, node => {
    const bundle = ir.assets.taskBundles[node.run.bundleId];
    if (bundle) node.run.digest = bundle.digest;
  });
}

function digest(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
