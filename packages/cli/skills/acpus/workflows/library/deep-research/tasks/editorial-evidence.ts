/** Deterministic editorial-reference validation and citation grounding Tasks. */
import { task, z, type ArtifactRef } from "acpus/core";
import {
  EvidenceLedger,
  EvidenceRef,
  GroundEditorialInput,
  ValidateEditorialInput,
  VerifiedClaim,
} from "../contracts.js";

type ClaimStatus = "confirmed" | "refuted" | "unverified";
type EvidenceRole = "support" | "correction" | "uncertainty";
type EvidenceRef = z.infer<typeof EvidenceRef>;
type LedgerClaim = z.infer<typeof VerifiedClaim>;
type Violation = { location: string; code: string; message: string };

const expectedStatus: Record<EvidenceRole, ClaimStatus> = {
  support: "confirmed",
  correction: "refuted",
  uncertainty: "unverified",
};

function claimsById(evidence: EvidenceLedger): Map<string, LedgerClaim> {
  return new Map(
    [...evidence.confirmed, ...evidence.refuted, ...evidence.unverified]
      .map(claim => [claim.claimId, claim]),
  );
}

function resolveEvidenceRef(byId: Map<string, LedgerClaim>, ref: EvidenceRef) {
  const claim = byId.get(ref.claimId);
  return {
    claim,
    key: `${ref.claimId}:${ref.role}`,
    expected: expectedStatus[ref.role],
  };
}

type ValidateEditorialInput = z.infer<typeof ValidateEditorialInput>;
type ValidateEditorialResult = {
  valid: boolean;
  artifact: ArtifactRef;
};

/** Validates editorial claim references against the ledger's status-specific evidence roles. */
export const validateEditorialEvidenceRefs = task.define({
  inputSchema: ValidateEditorialInput,
  exec: async ({ input, artifact }): Promise<ValidateEditorialResult> => {
    const value: ValidateEditorialInput = input;
    const { readFile } = await import("node:fs/promises");
    const evidence = JSON.parse(await readFile(artifact.path(value.ledger), "utf8")) as EvidenceLedger;
    const byId = claimsById(evidence);
    const violations: Violation[] = [];
    const validateRefs = (refs: EvidenceRef[], location: string, requiredRole?: EvidenceRole) => {
      if (refs.length === 0) {
        violations.push({ location, code: "missing_evidence", message: `${location} must cite at least one evidence record.` });
        return;
      }
      const seen = new Set<string>();
      for (const ref of refs) {
        const resolved = resolveEvidenceRef(byId, ref);
        if (seen.has(resolved.key)) {
          violations.push({ location, code: "duplicate_evidence", message: `${location} repeats ${resolved.key}.` });
          continue;
        }
        seen.add(resolved.key);
        if (!resolved.claim) {
          violations.push({ location, code: "unknown_claim", message: `${location} cites unknown claim '${ref.claimId}'.` });
        } else if (resolved.claim.status !== resolved.expected) {
          violations.push({
            location,
            code: "role_status_mismatch",
            message: `${location} uses ${ref.claimId} as ${ref.role}, but its ledger status is ${resolved.claim.status}.`,
          });
        }
      }
      if (requiredRole && !refs.some(ref => ref.role === requiredRole)) {
        violations.push({ location, code: "missing_required_role", message: `${location} needs at least one ${requiredRole} reference.` });
      }
    };

    if (!value.narrative.findings.some(item => item.kind === "finding")) {
      violations.push({ location: "Narrative", code: "missing_finding", message: "Confirmed evidence requires at least one positive finding." });
    }
    value.narrative.findings.forEach((item, index) => {
      validateRefs(item.evidenceRefs, `Narrative item ${index + 1}`, item.kind === "finding" ? "support" : "correction");
    });
    value.scrutiny.tensions.forEach((item, index) => {
      validateRefs(item.evidenceRefs, `Tension ${index + 1}`);
    });
    value.scrutiny.uncertainties.forEach((item, index) => {
      validateRefs(item.evidenceRefs, `Uncertainty ${index + 1}`, "uncertainty");
    });

    const payload = {
      schemaVersion: 1,
      valid: violations.length === 0,
      violations,
      draft: { narrative: value.narrative, scrutiny: value.scrutiny },
    };
    const file = await artifact.write(
      "editorial-validation.json",
      JSON.stringify(payload, null, 2),
      { mediaType: "application/json" },
    );
    return { valid: payload.valid, artifact: file };
  },
});

type GroundEditorialInput = z.infer<typeof GroundEditorialInput>;
type GroundEditorialResult = {
  artifact: ArtifactRef;
  editorialRepairCalls: number;
};

/** Projects validated claim references into citation-rich report content backed by ledger provenance. */
export const groundEditorialCitations = task.define({
  inputSchema: GroundEditorialInput,
  exec: async ({ input, artifact }): Promise<GroundEditorialResult> => {
    const value: GroundEditorialInput = input;
    const { readFile } = await import("node:fs/promises");
    const evidence = JSON.parse(await readFile(artifact.path(value.ledger), "utf8")) as EvidenceLedger;
    const byId = claimsById(evidence);
    const project = (refs: EvidenceRef[], label: string, requiredRole?: EvidenceRole) => {
      if (refs.length === 0) throw new Error(`${label} must cite at least one evidence record.`);
      if (requiredRole && !refs.some(ref => ref.role === requiredRole)) {
        throw new Error(`${label} must include at least one ${requiredRole} reference.`);
      }
      const seen = new Set<string>();
      const groundedRefs = refs.map(ref => {
        const resolved = resolveEvidenceRef(byId, ref);
        if (seen.has(resolved.key)) throw new Error(`${label} repeats evidence reference '${resolved.key}'.`);
        seen.add(resolved.key);
        if (!resolved.claim) throw new Error(`${label} cited unknown claimId '${ref.claimId}'.`);
        if (resolved.claim.status !== resolved.expected) {
          throw new Error(`${label} used ${ref.claimId} as ${ref.role}, but its ledger status is ${resolved.claim.status}.`);
        }
        const decision = ref.role === "support" ? "supports" : ref.role === "correction" ? "refutes" : undefined;
        const supports = resolved.claim.verdicts.filter(verdict => verdict.decision === "supports").length;
        const refutes = resolved.claim.verdicts.filter(verdict => verdict.decision === "refutes").length;
        const insufficient = resolved.claim.verdicts.length - supports - refutes;
        return {
          claimId: resolved.claim.claimId,
          role: ref.role,
          status: resolved.claim.status,
          claim: resolved.claim.claim,
          quote: resolved.claim.quote,
          vote: `supports=${supports}, refutes=${refutes}, insufficient=${insufficient}`,
          sourceUrl: resolved.claim.sourceUrl,
          sourceTitle: resolved.claim.sourceTitle,
          sourceQuality: resolved.claim.sourceQuality,
          verificationEvidence: resolved.claim.verdicts
            .filter(verdict => !decision || verdict.decision === decision)
            .map(verdict => ({
              decision: verdict.decision,
              evidence: verdict.evidence,
              confidence: verdict.confidence,
            })),
        };
      });
      return {
        evidenceRefs: groundedRefs,
        sources: [...new Map(groundedRefs.map(ref => [ref.sourceUrl, {
          url: ref.sourceUrl,
          title: ref.sourceTitle,
          quality: ref.sourceQuality,
        }])).values()],
      };
    };
    if (!value.narrative.findings.some(item => item.kind === "finding")) {
      throw new Error("A report with confirmed evidence requires at least one finding.");
    }
    const narrativeItems = value.narrative.findings.map((item, index) => ({
      kind: item.kind,
      heading: item.heading,
      analysis: item.analysis,
      confidence: item.confidence,
      ...project(item.evidenceRefs, `Narrative item ${index + 1}`, item.kind === "finding" ? "support" : "correction"),
    }));
    const tensions = value.scrutiny.tensions.map((tension, index) => ({
      heading: tension.heading,
      analysis: tension.analysis,
      ...project(tension.evidenceRefs, `Tension ${index + 1}`),
    }));
    const uncertainties = value.scrutiny.uncertainties.map((uncertainty, index) => ({
      heading: uncertainty.heading,
      analysis: uncertainty.analysis,
      ...project(uncertainty.evidenceRefs, `Uncertainty ${index + 1}`, "uncertainty"),
    }));
    const report = {
      schemaVersion: 1,
      language: value.reportLanguage,
      title: value.narrative.title,
      deck: value.narrative.deck,
      throughline: value.narrative.throughline,
      executiveSummary: value.narrative.executiveSummary,
      findings: narrativeItems.filter(item => item.kind === "finding"),
      corrections: narrativeItems.filter(item => item.kind === "correction"),
      tensions,
      uncertainties,
      implications: value.narrative.implications,
      limitations: value.scrutiny.limitations,
      openQuestions: value.scrutiny.openQuestions,
    };
    const file = await artifact.write(
      "grounded-report.json",
      JSON.stringify(report, null, 2),
      { mediaType: "application/json" },
    );
    return {
      artifact: file,
      editorialRepairCalls: value.editorialRepairCalls,
    };
  },
});
