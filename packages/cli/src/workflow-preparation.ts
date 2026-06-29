import { prepareWorkflow, WorkflowPreparationError } from "@acpus/workflow-compiler";
import { CliError } from "./errors.js";
import { summarizeWorkflow } from "./output.js";

export async function prepareWorkflowForCli(workflow: string, cwd: string): ReturnType<typeof prepareWorkflow> {
  try {
    return await prepareWorkflow({ workflow, cwd });
  } catch (error) {
    if (!(error instanceof WorkflowPreparationError)) throw error;
    const failure = error.failure;
    if (failure.phase === "typecheck") {
      throw new CliError(1, {
        ok: false,
        phase: "typecheck",
        message: failure.message,
        typecheck: failure.typecheck,
      });
    }
    if (failure.phase === "compile") {
      throw new CliError(1, {
        ok: false,
        phase: "compile",
        message: failure.message,
      });
    }
    throw new CliError(1, {
      ok: false,
      phase: "validate",
      message: failure.message,
      workflow: summarizeWorkflow(failure.ir),
      diagnostics: failure.diagnostics,
    });
  }
}
