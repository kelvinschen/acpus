import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import {
  tryPrepareWorkflow,
  type PreparedWorkflow,
  type WorkflowPreparationFailure,
  type WorkflowSourceInput,
} from "@acpus/workflow-compiler";
import {
  resolveWorkflowReference,
  type AvailableWorkflowCatalogEntry,
  type WorkflowCatalogScopeOptions,
} from "./catalog.js";
import { CliError, usageError } from "../presentation/errors.js";
import { summarizeWorkflow } from "../presentation/output.js";

export type WorkflowSourceResolution = {
  source: WorkflowSourceInput;
  catalog?: AvailableWorkflowCatalogEntry;
};

type WorkflowSourceOptions = WorkflowCatalogScopeOptions & {
  workspaceDir: string;
  workflow: string;
  stdin?: Readable;
};

export async function resolveWorkflowSourceForCli(options: WorkflowSourceOptions): Promise<WorkflowSourceResolution> {
  if (options.workflow === "-") {
    if (options.project || options.global) {
      throw usageError("Workflow source '-' cannot be used with --project or --global.");
    }
    if (options.stdin === undefined) throw usageError("Workflow source '-' requires standard input.");
    return {
      source: {
        kind: "files",
        entry: "workflow.ts",
        files: [{ path: "workflow.ts", content: await readUtf8(options.stdin) }],
      },
    };
  }

  const resolved = await resolveWorkflowReference(options.workspaceDir, options.workflow, options);
  return {
    source: { kind: "path", entry: resolved.workflow },
    ...(resolved.catalog === undefined ? {} : { catalog: resolved.catalog }),
  };
}

export async function prepareWorkflowForCli(
  options: WorkflowSourceOptions,
): Promise<{ prepared: PreparedWorkflow; catalog?: AvailableWorkflowCatalogEntry }> {
  const resolved = await resolveWorkflowSourceForCli(options);
  const result = await tryPrepareWorkflow({
    workspaceDir: options.workspaceDir,
    source: resolved.source,
  });
  return result.match(
    prepared => ({
      prepared,
      ...(resolved.catalog === undefined ? {} : { catalog: resolved.catalog }),
    }),
    failure => {
      throw workflowPreparationCliError(failure);
    },
  );
}

async function readUtf8(stdin: Readable): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin) {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(chunk);
    else throw usageError("Workflow source from stdin must be UTF-8 text.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw usageError("Workflow source from stdin must be valid UTF-8.");
  }
}

export function workflowPreparationCliError(failure: WorkflowPreparationFailure): CliError {
  if (failure.type === "source-invalid" || failure.type === "source-changed") {
    return new CliError(1, {
      ok: false,
      phase: "source",
      message: failure.message,
    });
  }
  if (failure.type === "check-failed") {
    return new CliError(1, {
      ok: false,
      phase: "check",
      message: failure.message,
      diagnostics: failure.diagnostics,
    });
  }
  if (failure.type === "compile-failed") {
    return new CliError(1, {
      ok: false,
      phase: "compile",
      message: failure.message,
    });
  }
  if (failure.type === "package-lock-read-failed") {
    return new CliError(1, {
      ok: false,
      phase: "lock",
      message: failure.message,
    });
  }
  return new CliError(1, {
    ok: false,
    phase: "validate",
    message: failure.message,
    workflow: summarizeWorkflow(failure.ir),
    diagnostics: failure.diagnostics,
  });
}
