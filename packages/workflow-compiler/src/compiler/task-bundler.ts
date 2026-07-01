import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { build } from "esbuild";
import type { DiagnosticIR, TaskBundleIR, WorkflowIR } from "@acpus/core/ir";
import { forEachTaskNode } from "./ir-walk.js";
import type { TaskBundleMetadata } from "../task-analysis/index.js";

export type BundleTaskOptions = {
  cwd: string;
  conditions?: string[];
  metadata: Map<string, TaskBundleMetadata>;
};

export async function bundleWorkflowTasks(ir: WorkflowIR, options: BundleTaskOptions): Promise<void> {
  const byBundle = metadataByBundleId(ir, options.metadata);
  for (const bundle of Object.values(ir.assets.taskBundles)) {
    const analyzed = byBundle.get(bundle.id);
    const result = await bundleTask(bundle, analyzed, options);
    if (!result.ok) {
      ir.diagnostics.push(result.diagnostic);
      continue;
    }
    bundle.source = result.source;
    if (analyzed?.metadata?.sourceFile) bundle.sourceFile = analyzed.metadata.sourceFile;
    bundle.digest = digest(result.source);
  }
  syncTaskRunDigests(ir);
  ir.lock.taskBundleDigests = Object.fromEntries(
    Object.entries(ir.assets.taskBundles).map(([id, bundle]) => [id, bundle.digest]),
  );
}

function metadataByBundleId(ir: WorkflowIR, metadataByStepId: Map<string, TaskBundleMetadata>): Map<string, BundleMetadata> {
  const byBundle = new Map<string, BundleMetadata>();
  forEachTaskNode(ir.root, node => {
    const metadata = metadataByStepId.get(node.id);
    if (!metadata) {
      byBundle.set(node.run.bundleId, { invalid: "missing" });
      return;
    }
    // Distinct callsites can share a bundle id (identical task source). The
    // bundle is admissible only if every reusable callsite has metadata.
    const existing = byBundle.get(node.run.bundleId);
    if (existing?.invalid) {
      return;
    } else if (existing?.metadata && metadata && !sameMetadata(existing.metadata, metadata)) {
      byBundle.set(node.run.bundleId, { invalid: "conflict" });
    } else if (!existing) {
      const entry: BundleMetadata = {};
      if (metadata) entry.metadata = metadata;
      byBundle.set(node.run.bundleId, entry);
    }
  });
  return byBundle;
}

type BundleMetadata = {
  metadata?: TaskBundleMetadata;
  invalid?: "missing" | "conflict";
};

type BundleResult =
  | { ok: true; source: string }
  | { ok: false; diagnostic: DiagnosticIR };

async function bundleTask(bundle: TaskBundleIR, analyzed: BundleMetadata | undefined, options: BundleTaskOptions): Promise<BundleResult> {
  if (analyzed?.invalid === "conflict") return bundleError(bundle, "TB001", "has conflicting statically resolved source file metadata.", ".sourceFile");
  if (analyzed?.invalid === "missing") return bundleError(bundle, "TB001", "is missing statically resolved task analysis metadata.", ".source");
  if (bundle.inline) {
    if (!bundle.source) return bundleError(bundle, "TB002", "is missing source for bundling.", ".source");
    return bundleSource({ bundle, contents: `export default ${bundle.source};\n`, resolveDir: options.cwd, options });
  }
  const sourceFile = analyzed?.metadata?.sourceFile;
  if (!sourceFile) return bundleError(bundle, "TB001", "is missing statically resolved source file metadata.", ".sourceFile");
  const exportName = analyzed?.metadata?.exportName ?? "default";
  return bundleSource({
    bundle,
    contents: reusableEntrySource(sourceFile, exportName),
    resolveDir: dirname(sourceFile),
    options,
  });
}

function sameMetadata(left: TaskBundleMetadata, right: TaskBundleMetadata): boolean {
  return left.inline === right.inline
    && left.sourceFile === right.sourceFile
    && left.exportName === right.exportName
    && left.sourceKind === right.sourceKind;
}

function reusableEntrySource(sourceFile: string, exportName: string): string {
  // Workflow-module task exports intentionally use normal ESM import semantics:
  // the module top level may run, but the workflow build callback does not.
  if (exportName === "default") return `import token from ${JSON.stringify(sourceFile)};\nexport default token.fn;\n`;
  return `import { ${exportName} as token } from ${JSON.stringify(sourceFile)};\nexport default token.fn;\n`;
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
