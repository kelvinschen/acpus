/**
 * Minimal structured joints for the bundled wide-research workflow.
 *
 * Research semantics stay in Agent-authored prose. Structure is limited to the
 * fanout joints and exact source/dataset attachments reused by publication.
 */
import { z } from "acpus/core";
import { EvidenceAttachments } from "../shared/research/evidence-attachments.js";

const RubricField = z.object({
  name: z.string(),
  description: z.string(),
  required: z.boolean(),
});

const RequiredUnit = z.object({
  canonicalKey: z.string(),
  title: z.string(),
  locator: z.string().nullable(),
});

const CoverageCellPlan = z.object({
  title: z.string(),
  boundary: z.string(),
  approach: z.string(),
  requiredUnits: z.array(RequiredUnit),
});

export const LeadPlanOutput = z.object({
  researchBrief: z.string(),
  coverageUnit: z.string(),
  identityRule: z.string(),
  rubric: z.array(RubricField),
  cells: z.array(CoverageCellPlan),
});

/** One Cell Worker keeps prose semantics and exact acquisition data together. */
export const CoverageCellOutput = EvidenceAttachments.extend({
  cellId: z.string(),
  records: z.array(z.string()),
  digest: z.string(),
  coverageNote: z.string(),
});
