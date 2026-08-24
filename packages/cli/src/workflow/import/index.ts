import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  prepareWorkflowCatalogCommit,
  type AvailableWorkflowCatalogEntry,
  type WorkflowCatalogScope,
} from "../catalog.js";
import {
  abortImport,
  causeMessage,
  WorkflowImportAbort,
  type WorkflowImportFailure,
} from "./failure.js";
import {
  checkWorkflowImportPackage,
  prepareWorkflowImportPackage,
  type CheckedWorkflowImportPackage,
} from "./package.js";
import {
  acquireWorkflowImportSource,
  classifyWorkflowImportSource,
} from "./source.js";
import { ensurePrivateAcpusDirectory, removePrivateTree } from "../../platform/private-directory.js";

export type { WorkflowImportFailure } from "./failure.js";

export type WorkflowImportResult = {
  catalog: AvailableWorkflowCatalogEntry;
} & ({
  checked: false;
} | ({
  checked: true;
} & CheckedWorkflowImportPackage));

type ImportOptions = {
  cwd: string;
  source: string;
  scope: WorkflowCatalogScope;
  check: boolean;
};

export function importWorkflowPackage(options: ImportOptions): Effect.Effect<WorkflowImportResult, WorkflowImportFailure> {
  return Effect.tryPromise({
    try: () => runImport(options),
    catch: cause => cause instanceof WorkflowImportAbort
      ? cause.failure
      : { type: "import", errorCode: "IMPORT_FAILED", message: `Workflow import failed: ${causeMessage(cause)}` },
  });
}

async function runImport(options: ImportOptions): Promise<WorkflowImportResult> {
  const source = await classifyWorkflowImportSource(options.cwd, options.source);
  const importRoot = workflowImportRoot(options.cwd, options.scope);
  if (options.scope === "global") await ensurePrivateAcpusDirectory(importRoot);
  else await mkdir(importRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(importRoot, "import-"));
  const stagedPackage = join(stagingRoot, "package");
  let outcome: { ok: true; value: WorkflowImportResult } | { ok: false; error: WorkflowImportAbort };
  try {
    const acquired = await acquireWorkflowImportSource(source, stagingRoot, stagedPackage);
    const preparedPackage = await prepareWorkflowImportPackage(acquired, stagingRoot, stagedPackage);
    const commit = await Effect.runPromise(Effect.result(
      prepareWorkflowCatalogCommit(options.cwd, options.scope, preparedPackage.name),
    ));
    if (Result.isFailure(commit)) abortImport(catalogImportErrorCode(commit.failure.type), commit.failure.message);

    const preparation = options.check
      ? await checkWorkflowImportPackage(options.cwd, stagedPackage, preparedPackage.name)
      : undefined;
    const committed = await Effect.runPromise(Effect.result(commit.success.commit(stagedPackage)));
    if (Result.isFailure(committed)) abortImport(catalogImportErrorCode(committed.failure.type), committed.failure.message);
    outcome = {
      ok: true,
      value: preparation === undefined
        ? { checked: false, catalog: committed.success }
        : { checked: true, catalog: committed.success, ...preparation },
    };
  } catch (error) {
    outcome = {
      ok: false,
      error: error instanceof WorkflowImportAbort
        ? error
        : new WorkflowImportAbort({ type: "import", errorCode: "IMPORT_FAILED", message: `Workflow import failed: ${causeMessage(error)}` }),
    };
  }
  try {
    await removePrivateTree(stagingRoot);
  } catch (cleanupError) {
    outcome = {
      ok: false,
      error: importCleanupFailure(outcome.ok ? undefined : outcome.error, cleanupError, outcome.ok ? outcome.value : undefined),
    };
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function importCleanupFailure(
  operation: WorkflowImportAbort | undefined,
  cleanupError: unknown,
  committed: WorkflowImportResult | undefined,
): WorkflowImportAbort {
  const cleanupCause = causeMessage(cleanupError);
  const cleanup = `Temporary import cleanup failed: ${cleanupCause}`;
  if (operation === undefined) {
    const completed = committed === undefined
      ? "Workflow import completed"
      : `Workflow '${committed.catalog.scope}/${committed.catalog.name}' was imported`;
    return new WorkflowImportAbort({
      type: "import",
      errorCode: "IMPORT_CLEANUP_FAILED",
      message: `${completed}, but temporary import cleanup failed: ${cleanupCause}`,
    });
  }
  if (operation.failure.type === "preparation") {
    return new WorkflowImportAbort({
      type: "preparation",
      failure: {
        ...operation.failure.failure,
        message: `${operation.failure.failure.message} ${cleanup}`,
      },
    });
  }
  return new WorkflowImportAbort({
    ...operation.failure,
    message: `${operation.failure.message} ${cleanup}`,
  });
}

function workflowImportRoot(cwd: string, scope: WorkflowCatalogScope): string {
  return scope === "project"
    ? resolve(cwd, ".acpus", "tmp")
    : resolve(homedir(), ".acpus", "tmp", "workflow-imports");
}

function catalogImportErrorCode(type: "invalid-name" | "collision" | "commit-failed"): string {
  if (type === "invalid-name") return "IMPORT_NAME_INVALID";
  if (type === "collision") return "IMPORT_COLLISION";
  return "IMPORT_COMMIT_FAILED";
}
