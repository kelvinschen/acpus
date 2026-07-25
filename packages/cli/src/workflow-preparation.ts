import {
  tryPrepareWorkflow,
  type PreparedWorkflow,
  type WorkflowPreparationFailure,
  type WorkflowPreparationSource,
} from "@acpus/workflow-compiler";
import { CliError } from "./errors.js";
import { summarizeWorkflow } from "./output.js";

export async function prepareWorkflowForCli(
  workflow: string,
  cwd: string,
  source?: { ref: WorkflowPreparationSource; root: string },
): Promise<PreparedWorkflow> {
  const result = await tryPrepareWorkflow({
    workflow,
    cwd,
    ...(source === undefined ? {} : { source: source.ref, sourceRoot: source.root }),
  });
  return result.match(
    prepared => prepared,
    failure => {
      throw workflowPreparationCliError(failure);
    },
  );
}

export function workflowPreparationCliError(failure: WorkflowPreparationFailure): CliError {
  if (failure.type === "source-invalid") {
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
