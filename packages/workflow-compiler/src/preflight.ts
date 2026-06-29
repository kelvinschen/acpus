import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { WorkflowIR } from "@acpus/core";
import { compileWorkflow } from "./compile.js";
import { createScratchDir, type TypecheckResult, typecheckWorkflow } from "./typecheck.js";

export type PreflightOptions = {
  workflow: string;
  cwd: string;
};

export type WorkflowLockArtifact = {
  kind: "acpus_preflight_lock";
  version: 1;
  workflow: {
    entry: string;
    sourceDigest?: string;
  };
  ir: {
    path: "workflow.ir.json";
    digest: string;
  };
  packageLockDigest?: string;
  sourceGraphDigest: string;
  taskBundles: Record<string, { digest: string; path: string }>;
  generatedAt: string;
};

export type PreparedWorkflow = {
  workflowPath: string;
  ir: WorkflowIR;
  irJson: string;
  irDigest: string;
  sourceGraphDigest: string;
  packageLockDigest?: string;
  lock: WorkflowLockArtifact;
};

export type PreflightArtifact = {
  dir: string;
};

type TypecheckFailure = Extract<TypecheckResult, { ok: false }>;

export type WorkflowPreparationFailure =
  | { phase: "typecheck"; message: string; typecheck: TypecheckFailure }
  | { phase: "compile"; message: string }
  | { phase: "validate"; message: string; diagnostics: WorkflowIR["diagnostics"]; ir: WorkflowIR };

export class WorkflowPreparationError extends Error {
  constructor(readonly failure: WorkflowPreparationFailure) {
    super(failure.message);
  }
}

export async function prepareWorkflow(options: PreflightOptions): Promise<PreparedWorkflow> {
  const workflowPath = resolve(options.cwd, options.workflow);
  const scratchDir = await createScratchDir();
  try {
    const typecheck = await typecheckWorkflow(workflowPath, options.cwd, scratchDir);
    if (!typecheck.ok) {
      throw new WorkflowPreparationError({
        phase: "typecheck",
        message: "Workflow typecheck failed.",
        typecheck,
      });
    }

    const compiled = await compileWorkflow(workflowPath, options.cwd, scratchDir);
    if (!compiled.ok) {
      throw new WorkflowPreparationError({
        phase: "compile",
        message: compiled.message,
      });
    }

    if (compiled.ir.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      throw new WorkflowPreparationError({
        phase: "validate",
        message: "Workflow validation failed.",
        diagnostics: compiled.ir.diagnostics,
        ir: compiled.ir,
      });
    }

    const irJson = `${JSON.stringify(compiled.ir, null, 2)}\n`;
    const irDigest = digest(irJson);
    const packageLock = await packageLockDigest(options.cwd);
    const sourceGraphDigest = digest([
      compiled.ir.lock.workflowSourceDigest ?? "",
      packageLock ?? "",
      ...Object.values(compiled.ir.assets.taskBundles).map(bundle => bundle.digest).sort(),
    ].join("\n"));

    return {
      workflowPath,
      ir: compiled.ir,
      irJson,
      irDigest,
      sourceGraphDigest,
      ...(packageLock ? { packageLockDigest: packageLock } : {}),
      lock: buildLock(compiled.ir, workflowPath, options.cwd, irDigest, sourceGraphDigest, packageLock),
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

export async function writePreflightArtifact(prepared: PreparedWorkflow, cwd: string): Promise<PreflightArtifact> {
  const id = `${timestampId()}-${prepared.irDigest.slice("sha256:".length, "sha256:".length + 12)}`;
  const dir = join(cwd, ".acpus", "preflight", id);
  const bundleDir = join(dir, "task-bundles");
  await mkdir(bundleDir, { recursive: true });
  for (const bundle of Object.values(prepared.ir.assets.taskBundles)) {
    await writeFile(join(bundleDir, `${bundle.id}.mjs`), bundle.source ?? "");
  }
  await writeFile(join(dir, "workflow.ir.json"), prepared.irJson);
  await writeFile(join(dir, "lock.json"), `${JSON.stringify(prepared.lock, null, 2)}\n`);
  return { dir };
}

function buildLock(ir: WorkflowIR, workflowPath: string, cwd: string, irDigest: string, sourceGraphDigest: string, packageLock: string | undefined): WorkflowLockArtifact {
  return {
    kind: "acpus_preflight_lock",
    version: 1,
    workflow: {
      entry: relative(cwd, workflowPath),
      ...(ir.lock.workflowSourceDigest ? { sourceDigest: ir.lock.workflowSourceDigest } : {}),
    },
    ir: {
      path: "workflow.ir.json",
      digest: irDigest,
    },
    ...(packageLock ? { packageLockDigest: packageLock } : {}),
    sourceGraphDigest,
    taskBundles: Object.fromEntries(Object.values(ir.assets.taskBundles).map(bundle => [
      bundle.id,
      { digest: bundle.digest, path: `task-bundles/${bundle.id}.mjs` },
    ])),
    generatedAt: new Date().toISOString(),
  };
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
