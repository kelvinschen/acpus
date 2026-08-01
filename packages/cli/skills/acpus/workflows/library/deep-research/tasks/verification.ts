/** Deterministic verification coverage and majority-tally Tasks. */
import { task, z } from "acpus/core";
import {
  InitialVerificationResult,
  RequireInitialVerdictsInput,
  RequireTieBreakVerdictsInput,
  TallyVerifiedClaimsInput,
  TieBreakerResult,
  VerificationVerdictOutput,
  VerifiedClaim,
} from "../contracts.js";

type RequireInitialVerdictsInput = z.infer<typeof RequireInitialVerdictsInput>;
type InitialVerdictsResult = z.infer<typeof InitialVerificationResult>;

/** Validates complete two-voter coverage and identifies claims that need a tie-break decision. */
export const requireInitialVerdicts = task.define({
  inputSchema: RequireInitialVerdictsInput,
  exec: async ({ input }): Promise<InitialVerdictsResult> => {
    const value: RequireInitialVerdictsInput = input;
    const expectedIds = value.claims.map(claim => claim.claimId);
    const normalize = (label: string, result: typeof value.voterA) => {
      if (result.status !== "ok") {
        throw new Error(`Verifier ${label} requires Web Search: ${result.error || "tool unavailable"}`);
      }
      const actualIds = result.verdicts.map(verdict => verdict.claimId);
      const duplicates = actualIds.filter((id, index) => actualIds.indexOf(id) !== index);
      const missing = expectedIds.filter(id => !actualIds.includes(id));
      const unexpected = actualIds.filter(id => !expectedIds.includes(id));
      if (actualIds.length !== expectedIds.length || duplicates.length || missing.length || unexpected.length) {
        throw new Error(`Verifier ${label} coverage mismatch: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}; duplicates=${duplicates.join(",") || "none"}.`);
      }
      const byId = new Map(result.verdicts.map(verdict => [verdict.claimId, verdict]));
      return expectedIds.map(id => byId.get(id)!);
    };
    const voterA = normalize("A", value.voterA);
    const voterB = normalize("B", value.voterB);
    const reviews = value.claims.map((claim, index) => ({
      claim,
      verdicts: [voterA[index]!, voterB[index]!],
    }));
    return { reviews };
  },
});

type RequireTieBreakVerdictsInput = z.infer<typeof RequireTieBreakVerdictsInput>;
type TieBreakVerdictsResult = z.infer<typeof TieBreakerResult>;

/** Validates that a tie-breaker result covers its disputed batch exactly once. */
export const requireTieBreakVerdicts = task.define({
  inputSchema: RequireTieBreakVerdictsInput,
  exec: async ({ input }): Promise<TieBreakVerdictsResult> => {
    const value: RequireTieBreakVerdictsInput = input;
    if (value.result.status !== "ok") {
      throw new Error(`The tie-breaker Agent requires Web Search: ${value.result.error || "tool unavailable"}`);
    }
    const expectedIds = value.claims.map(claim => claim.claimId);
    const actualIds = value.result.verdicts.map(candidate => candidate.claimId);
    const duplicates = actualIds.filter((id, index) => actualIds.indexOf(id) !== index);
    const missing = expectedIds.filter(id => !actualIds.includes(id));
    const unexpected = actualIds.filter(id => !expectedIds.includes(id));
    if (actualIds.length !== expectedIds.length || duplicates.length || missing.length || unexpected.length) {
      throw new Error(`Tie-breaker coverage mismatch: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}; duplicates=${duplicates.join(",") || "none"}.`);
    }
    const byId = new Map(value.result.verdicts.map(candidate => [candidate.claimId, candidate]));
    return { verdicts: expectedIds.map(id => byId.get(id)!) };
  },
});

type TallyVerifiedClaimsInput = z.infer<typeof TallyVerifiedClaimsInput>;
type TallyVerifiedClaimsResult = {
  claims: Array<z.infer<typeof VerifiedClaim>>;
  verificationAgentCalls: number;
  tieBreakerAgentCalls: number;
};

/** Combines initial and tie-break verdicts into final claim statuses and verification call counts. */
export const tallyVerifiedClaims = task.define({
  inputSchema: TallyVerifiedClaimsInput,
  exec: async ({ input }): Promise<TallyVerifiedClaimsResult> => {
    const value: TallyVerifiedClaimsInput = input;
    const tieVerdicts = value.tieBreakers.flatMap(batch => batch.verdicts);
    const tieById = new Map(tieVerdicts.map(verdict => [verdict.claimId, verdict]));
    if (tieById.size !== tieVerdicts.length) throw new Error("Tie-breaker output contains a duplicate claimId across batches.");
    const disputedIds = new Set(value.reviews
      .filter(review => review.verdicts[0]!.decision !== review.verdicts[1]!.decision)
      .map(review => review.claim.claimId));
    if (tieById.size !== disputedIds.size
      || [...disputedIds].some(claimId => !tieById.has(claimId))
      || [...tieById.keys()].some(claimId => !disputedIds.has(claimId))) {
      throw new Error("Tie-breaker verdicts do not exactly cover the disputed claims.");
    }
    const claims = value.reviews.map(review => {
      const tie = tieById.get(review.claim.claimId);
      const rawVerdicts: Array<z.infer<typeof VerificationVerdictOutput>> = tie
        ? [...review.verdicts, tie]
        : review.verdicts;
      const verdicts = rawVerdicts.map(({ claimId: _claimId, ...verdict }) => verdict);
      const supports = verdicts.filter(verdict => verdict.decision === "supports").length;
      const refutes = verdicts.filter(verdict => verdict.decision === "refutes").length;
      const status = refutes >= 2 ? "refuted" as const
        : supports >= 2 ? "confirmed" as const
          : "unverified" as const;
      return {
        ...review.claim,
        verdicts,
        status,
      };
    });
    return {
      claims,
      verificationAgentCalls: value.initialAgentCalls + value.tieBreakers.length,
      tieBreakerAgentCalls: value.tieBreakers.length,
    };
  },
});
