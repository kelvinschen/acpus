/** Minimal graph-control contracts for the lead-centered research loop. */
import { z } from "acpus/core";

const ResearchAssignment = z.object({
  title: z.string(),
  brief: z.string(),
});

export const LeadPlanOutput = z.object({
  memo: z.string(),
  assignments: z.array(ResearchAssignment),
});

export const LeadReviewOutput = z.object({
  complete: z.boolean(),
  memo: z.string(),
  assignments: z.array(ResearchAssignment),
});

export type ResearchRecord = {
  round: number;
  groupId: string;
  title: string;
  brief: string;
  memo: string;
};
