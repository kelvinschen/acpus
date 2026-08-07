/**
 * Data contracts for the bundled deep-research workflow.
 *
 * Semantic findings, skeptic review, and publication drafts remain prose.
 * Structure is limited to graph-control joints and exact source/dataset
 * attachments that both research workflows hand to publication.
 */
import { z } from "acpus/core";
import { EvidenceAttachments } from "../shared/research/evidence-attachments.js";

/** One independent investigation lane a single worker owns end to end. */
export const LaneSpec = z.object({
  title: z.string(),
  brief: z.string(),
});

export type LaneSpec = z.infer<typeof LaneSpec>;

export const LeadPlanOutput = z.object({
  /** Markdown publication strategy carried opaquely between Agents. */
  researchBrief: z.string(),
  lanes: z.array(LaneSpec),
});

export const GapPlanOutput = z.object({
  sufficient: z.boolean(),
  coverage: z.string(),
  gaps: z.array(LaneSpec),
});

/**
 * One worker's self-contained investigation of a single lane. Code deduplicates
 * on `laneTitle`; `report` keeps each semantic finding, inference, confidence,
 * and caveat together, while reusable sources and datasets use the shared
 * acquisition-data shape.
 */
export const LaneReport = EvidenceAttachments.extend({
  laneTitle: z.string(),
  report: z.string(),
});

export type LaneReport = z.infer<typeof LaneReport>;
