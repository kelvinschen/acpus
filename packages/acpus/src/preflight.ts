import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { WorkflowIR } from "@acpus/core";
import { compileWorkflow } from "./compile.js";
import { CliError } from "./errors.js";
import { summarizeWorkflow, type CliResult } from "./output.js";
import { createScratchDir, typecheckWorkflow } from "./typecheck.js";

export type PreflightOptions = {
  workflow: string;
  cwd: string;
};

export async function runPreflight(options: PreflightOptions): Promise<CliResult & { ok: true; phase: "dry-run" }> {
  const workflowPath = resolve(options.cwd, options.workflow);
  const scratchDir = await createScratchDir();
  try {
    const typecheck = await typecheckWorkflow(workflowPath, options.cwd, scratchDir);
    if (!typecheck.ok) {
      throw new CliError(1, {
        ok: false,
        phase: "typecheck",
        message: "Workflow typecheck failed.",
        typecheck,
      });
    }

    const compiled = await compileWorkflow(workflowPath, options.cwd, scratchDir);
    if (!compiled.ok) {
      throw new CliError(1, {
        ok: false,
        phase: "compile",
        message: compiled.message,
      });
    }

    const summary = summarizeWorkflow(compiled.ir);
    if (summary.diagnostics.errors > 0) {
      throw new CliError(1, {
        ok: false,
        phase: "validate",
        message: "Workflow validation failed.",
        workflow: summary,
        diagnostics: compiled.ir.diagnostics,
      });
    }

    const artifact = await writePreflightArtifact(compiled.ir, workflowPath, options.cwd);

    return {
      ok: true,
      phase: "dry-run",
      message: "Workflow dry-run passed.",
      workflow: summary,
      diagnostics: compiled.ir.diagnostics,
      preflightDir: artifact.dir,
      irDigest: artifact.irDigest,
      taskBundleCount: Object.keys(compiled.ir.assets.taskBundles).length,
      sourceGraphDigest: artifact.sourceGraphDigest,
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function writePreflightArtifact(ir: WorkflowIR, workflowPath: string, cwd: string): Promise<{
  dir: string;
  irDigest: string;
  sourceGraphDigest: string;
}> {
  const irJson = `${JSON.stringify(ir, null, 2)}\n`;
  const irDigest = digest(irJson);
  const sourceGraphDigest = digest([
    ir.lock.workflowSourceDigest ?? "",
    await packageLockDigest(cwd) ?? "",
    ...Object.values(ir.assets.taskBundles).map(bundle => bundle.digest).sort(),
  ].join("\n"));
  const id = `${timestampId()}-${irDigest.slice("sha256:".length, "sha256:".length + 12)}`;
  const dir = join(cwd, ".acpus", "preflight", id);
  const bundleDir = join(dir, "task-bundles");
  await mkdir(bundleDir, { recursive: true });
  for (const bundle of Object.values(ir.assets.taskBundles)) {
    await writeFile(join(bundleDir, `${bundle.id}.mjs`), bundle.source ?? "");
  }
  await writeFile(join(dir, "workflow.ir.json"), irJson);
  await writeFile(join(dir, "lock.json"), `${JSON.stringify({
    kind: "acpus_preflight_lock",
    version: 1,
    workflow: {
      entry: relative(cwd, workflowPath),
      sourceDigest: ir.lock.workflowSourceDigest,
    },
    ir: {
      path: "workflow.ir.json",
      digest: irDigest,
    },
    packageLockDigest: await packageLockDigest(cwd),
    sourceGraphDigest,
    taskBundles: Object.fromEntries(Object.values(ir.assets.taskBundles).map(bundle => [
      bundle.id,
      { digest: bundle.digest, path: `task-bundles/${bundle.id}.mjs` },
    ])),
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return { dir, irDigest, sourceGraphDigest };
}

async function packageLockDigest(cwd: string): Promise<string | undefined> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    try {
      return digest(await readFile(join(cwd, name), "utf8"));
    } catch {
      // Try the next common lockfile name.
    }
  }
  return undefined;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function timestampId(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
