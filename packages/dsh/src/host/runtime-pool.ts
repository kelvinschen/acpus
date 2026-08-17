import { realpath } from "node:fs/promises";
import {
  openWorkspaceRuntime,
  type WorkspaceRuntime,
  type WorkspaceRuntimeHostDependencies,
  type WorkspaceRuntimeOpenFailure,
} from "@acpus/runtime/host";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { AcpusOperationError } from "./errors.js";

export type RuntimePoolOpenFailure =
  | {
      type: "workspace-unavailable";
      workspace: string;
      message: string;
      cause?: unknown;
    }
  | WorkspaceRuntimeOpenFailure;

export type OpenedWorkspaceRuntime = {
  workspace: string;
  runtime: WorkspaceRuntime;
};

export class RuntimePool {
  private readonly runtimes = new Map<
    string,
    Promise<Result<WorkspaceRuntime, WorkspaceRuntimeOpenFailure>>
  >();
  private closed = false;

  constructor(
    private readonly stateRoot: string,
    private readonly dependencies: WorkspaceRuntimeHostDependencies = {},
  ) {}

  open(workspace: string): ResultAsync<OpenedWorkspaceRuntime, RuntimePoolOpenFailure> {
    if (this.closed) {
      throw new AcpusOperationError(
        "Acpus Runtime pool is closed.",
        "ACPUS_RUNTIME_CLOSED",
      );
    }
    return new ResultAsync(this.openResult(workspace));
  }

  private async openResult(
    workspace: string,
  ): Promise<Result<OpenedWorkspaceRuntime, RuntimePoolOpenFailure>> {
    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await realpath(workspace);
    } catch (error) {
      return err({
        type: "workspace-unavailable",
        workspace,
        message: `Acpus workspace '${workspace}' is unavailable. Restore the original path and retry.`,
        cause: error,
      });
    }
    if (this.closed) {
      throw new AcpusOperationError(
        "Acpus Runtime pool is closed.",
        "ACPUS_RUNTIME_CLOSED",
      );
    }
    let pending = this.runtimes.get(canonicalWorkspace);
    if (pending === undefined) {
      const opening = (async (): Promise<Result<WorkspaceRuntime, WorkspaceRuntimeOpenFailure>> => {
        return openWorkspaceRuntime({
          workspace: canonicalWorkspace,
          stateRoot: this.stateRoot,
        }, this.dependencies);
      })();
      pending = opening;
      this.runtimes.set(canonicalWorkspace, opening);
      void opening.then(
        opened => {
          if (opened.isErr() && this.runtimes.get(canonicalWorkspace) === opening) {
            this.runtimes.delete(canonicalWorkspace);
          }
        },
        () => {
          if (this.runtimes.get(canonicalWorkspace) === opening) {
            this.runtimes.delete(canonicalWorkspace);
          }
        },
      );
    }
    const opened = await pending;
    if (opened.isErr()) return err(opened.error);
    if (this.closed) {
      throw new AcpusOperationError(
        "Acpus Runtime pool closed while the workspace was opening.",
        "ACPUS_RUNTIME_CLOSED",
      );
    }
    return ok({ workspace: canonicalWorkspace, runtime: opened.value });
  }

  async close(): Promise<void> {
    this.closed = true;
    const settled = await Promise.allSettled(
      [...this.runtimes.values()].map(async pending => {
        const opened = await pending;
        if (opened.isOk()) await opened.value.close();
      }),
    );
    this.runtimes.clear();
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Acpus DSH runtimes could not all be closed.");
    }
  }
}
