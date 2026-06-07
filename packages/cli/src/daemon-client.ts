/**
 * DaemonClient — re-exported from @acpus/runtime.
 *
 * The implementation now lives in the runtime package so the CLI and the TUI
 * can share one client without a package cycle. This module is kept as a
 * back-compat re-export for existing CLI imports.
 */

export { DaemonClient } from "@acpus/runtime";
export type { RunState, NodeExecutionState, RunSummary, ReplayResult } from "@acpus/runtime";
