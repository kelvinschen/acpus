import { tryPrepareWorkflow, type PreparedWorkflow, type WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import { CliError } from "./errors.js";
import { summarizeWorkflow } from "./output.js";

export async function prepareWorkflowForCli(workflow: string, cwd: string): Promise<PreparedWorkflow> {
  const result = await tryPrepareWorkflow({ workflow, cwd });
  return result.match(
    prepared => prepared,
    failure => {
      throw workflowPreparationCliError(failure);
    },
  );
}

function workflowPreparationCliError(failure: WorkflowPreparationFailure): CliError {
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
  return new CliError(1, {
    ok: false,
    phase: "validate",
    message: failure.message,
    workflow: summarizeWorkflow(failure.ir),
    diagnostics: failure.diagnostics,
  });
}
