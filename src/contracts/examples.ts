import type { OutputContractName } from "./schemas.js";

export function minimalExampleForContract(name: OutputContractName, options: { outputKey?: string } = {}): Record<string, unknown> {
  const base = {
    status: "completed",
    summary: "Short factual stage summary.",
    artifacts: [],
    nextFocus: "next workflow focus"
  };
  if (name === "implementation") {
    return {
      ...base,
      changedFiles: [],
      checks: [{ name: "not run", status: "unknown", summary: "No checks were run." }]
    };
  }
  if (name === "validation") {
    return {
      ...base,
      verdict: "pass",
      severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
      findings: [],
      checks: []
    };
  }
  if (name === "decision") {
    return {
      ...base,
      route: "next_stage_id"
    };
  }
  if (name === "discover") {
    return {
      ...base,
      [options.outputKey ?? "items"]: []
    };
  }
  if (name === "summarize") {
    return {
      ...base,
      finalVerdict: "success",
      deliverables: [],
      changedFiles: [],
      checks: [],
      warnings: [],
      risks: [],
      nextActions: []
    };
  }
  if (name === "diagnostic") {
    return {
      ...base,
      data: {
        blockedCause: "short cause",
        recoveryAdvice: ["review the blocked stage output"],
        requiresNewRun: false
      }
    };
  }
  return base;
}
