/**
 * RunSupervisorClient — re-exported from @acpus/runtime.
 *
 * The implementation lives in the runtime package so the CLI and the TUI
 * can share one client without a package cycle.
 */

export { RunSupervisorClient } from "@acpus/runtime";
export type { RunState, NodeExecutionState, RunSummary, ReplayResult, SupervisorMetadata, SupervisorHealth } from "@acpus/runtime";
