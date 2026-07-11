import type { RunDetails, RunRecord } from "@acpus/runtime";

export function toRunRecord(run: RunDetails): RunRecord {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    workflowEntry: run.workflowEntry,
    sourceGraphDigest: run.sourceGraphDigest,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    progressVersion: run.progressVersion,
    ...(run.progressUpdatedAt === undefined ? {} : { progressUpdatedAt: run.progressUpdatedAt }),
  };
}
