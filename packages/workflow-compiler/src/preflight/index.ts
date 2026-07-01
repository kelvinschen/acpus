import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { WorkflowIR } from "@acpus/core/ir";
import { checkWorkflow } from "../check/runner.js";
import { compileWorkflow } from "../compiler/worker.js";
import { createScratchDir } from "./temp.js";

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

export type WorkflowPreparationFailure =
  | { phase: "check"; message: string; diagnostics: WorkflowIR["diagnostics"] }
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
    const check = await checkWorkflow(workflowPath, options.cwd, scratchDir);
    if (check.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      throw new WorkflowPreparationError({
        phase: "check",
        message: "Workflow check failed.",
        diagnostics: check.diagnostics,
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
  await mkdir(dir, { recursive: true });
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
