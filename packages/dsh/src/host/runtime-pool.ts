import { realpath } from "node:fs/promises";
import {
  openWorkspaceRuntime,
  type WorkspaceRuntime,
  type WorkspaceRuntimeHostDependencies,
} from "@acpus/runtime/host";
import {
  AcpusOperationError,
  WorkspaceRuntimeUnavailableError,
} from "./errors.js";

export class RuntimePool {
  private readonly runtimes = new Map<string, Promise<WorkspaceRuntime>>();
  private closed = false;

  constructor(
    private readonly stateRoot: string,
    private readonly dependencies: WorkspaceRuntimeHostDependencies = {},
  ) {}

  async open(workspace: string): Promise<{ workspace: string; runtime: WorkspaceRuntime }> {
    if (this.closed) {
      throw new AcpusOperationError(
        "Acpus Runtime pool is closed.",
        "ACPUS_RUNTIME_CLOSED",
      );
    }
    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await realpath(workspace);
    } catch (error) {
      throw new AcpusOperationError(
        `Acpus workspace '${workspace}' is unavailable.`,
        "ACPUS_WORKSPACE_UNAVAILABLE",
        { cause: error },
      );
    }
    if (this.closed) {
      throw new AcpusOperationError(
        "Acpus Runtime pool is closed.",
        "ACPUS_RUNTIME_CLOSED",
      );
    }
    let pending = this.runtimes.get(canonicalWorkspace);
    if (pending === undefined) {
      pending = (async () => {
        const result = await openWorkspaceRuntime({
          workspace: canonicalWorkspace,
          stateRoot: this.stateRoot,
        }, this.dependencies);
        if (result.isErr()) {
          this.runtimes.delete(canonicalWorkspace);
          throw new WorkspaceRuntimeUnavailableError(result.error);
        }
        return result.value;
      })();
      this.runtimes.set(canonicalWorkspace, pending);
    }
    const runtime = await pending;
    if (this.closed) {
      throw new AcpusOperationError(
        "Acpus Runtime pool closed while the workspace was opening.",
        "ACPUS_RUNTIME_CLOSED",
      );
    }
    return { workspace: canonicalWorkspace, runtime };
  }

  async close(): Promise<void> {
    this.closed = true;
    const settled = await Promise.allSettled(
      [...this.runtimes.values()].map(async pending => (await pending).close()),
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
