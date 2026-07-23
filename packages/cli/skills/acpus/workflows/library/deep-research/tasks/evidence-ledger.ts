/** Deterministic evidence-ledger assembly and final accounting Tasks. */
import { task, z, type ArtifactRef } from "acpus/core";
import {
  EvidenceLedger,
  FinalizeEvidenceLedgerInput,
  ResearchStats,
  WriteEvidenceLedgerInput,
} from "../contracts.js";

type WriteEvidenceLedgerInput = z.infer<typeof WriteEvidenceLedgerInput>;
type ResearchStats = z.infer<typeof ResearchStats>;
type WriteEvidenceLedgerResult = {
  artifact: ArtifactRef;
  hasConfirmed: boolean;
};

/** Classifies verified claims, computes research statistics, and writes the pre-editorial ledger. */
export const writeEvidenceLedger = task.define({
  inputSchema: WriteEvidenceLedgerInput,
  exec: async ({ input, artifact }): Promise<WriteEvidenceLedgerResult> => {
    const value: WriteEvidenceLedgerInput = input;
    const confirmed = value.verification.claims.filter(claim => claim.status === "confirmed");
    const refuted = value.verification.claims.filter(claim => claim.status === "refuted");
    const unverified = value.verification.claims.filter(claim => claim.status === "unverified");
    const verificationVotes = value.verification.claims.reduce((total, claim) => total + claim.verdicts.length, 0);
    const tieBreakersUsed = value.verification.claims.filter(claim => claim.verdicts.length > 2).length;
    const stats: ResearchStats = {
      searchRounds: value.planning.completedRounds,
      searchAngles: value.planning.searches.length,
      searchWorkerCalls: value.planning.searchAgentCalls,
      searchPlanningCalls: value.planning.planningAgentCalls,
      searchCandidates: value.selection.candidateCount,
      uniqueSources: value.selection.uniqueCount,
      sourcesFetched: value.selection.sourcesFetched,
      claimsExtracted: value.claimPool.claimsExtracted,
      duplicateClaims: value.claimPool.duplicateClaims,
      claimsDropped: value.claimPool.claimsDropped,
      claimsVerified: value.verification.claims.length,
      verificationVotes,
      tieBreakersUsed,
      verificationAgentCalls: value.verification.verificationAgentCalls,
      tieBreakerAgentCalls: value.verification.tieBreakerAgentCalls,
      confirmed: confirmed.length,
      refuted: refuted.length,
      unverified: unverified.length,
      rejectedUrls: value.selection.rejectedUrlCount,
      urlDupes: value.selection.duplicateCount,
      budgetDropped: value.selection.budgetDropped,
      editorialRepairCalls: 0,
      logicalAgentCalls: 1
        + value.planning.searchAgentCalls
        + value.planning.planningAgentCalls
        + value.selection.sourcesFetched
        + value.verification.verificationAgentCalls
        + (confirmed.length > 0 ? value.budget.editorialPasses : 0),
    };
    const payload: EvidenceLedger = {
      schemaVersion: 1,
      question: value.request.question,
      context: value.request.context,
      reportLanguage: value.request.reportLanguage,
      budget: value.budget,
      planning: {
        researchFrame: value.planning.researchFrame,
        decomposition: value.planning.decomposition,
        coverageSummary: value.planning.coverageSummary,
        completedRounds: value.planning.completedRounds,
        remainingGaps: value.planning.remainingGaps,
      },
      searches: value.planning.searches,
      sources: value.claimPool.sources,
      confirmed,
      refuted,
      unverified,
      stats,
    };
    const file = await artifact.write(
      "pre-editorial-evidence-ledger.json",
      JSON.stringify(payload, null, 2),
      { mediaType: "application/json" },
    );
    return { artifact: file, hasConfirmed: confirmed.length > 0 };
  },
});

type FinalizeEvidenceLedgerInput = z.infer<typeof FinalizeEvidenceLedgerInput>;

/** Adds editorial repair accounting and writes the final verified evidence ledger. */
export const finalizeEvidenceLedger = task.define({
  inputSchema: FinalizeEvidenceLedgerInput,
  exec: async ({ input, artifact }): Promise<{ artifact: ArtifactRef }> => {
    const value: FinalizeEvidenceLedgerInput = input;
    const { readFile } = await import("node:fs/promises");
    const payload = JSON.parse(await readFile(artifact.path(value.ledger), "utf8")) as EvidenceLedger;
    const stats: ResearchStats = {
      ...payload.stats,
      editorialRepairCalls: value.editorialRepairCalls,
      logicalAgentCalls: payload.stats.logicalAgentCalls + value.editorialRepairCalls,
    };
    const file = await artifact.write(
      "verified-evidence-ledger.json",
      JSON.stringify({ ...payload, stats }, null, 2),
      { mediaType: "application/json" },
    );
    return { artifact: file };
  },
});
