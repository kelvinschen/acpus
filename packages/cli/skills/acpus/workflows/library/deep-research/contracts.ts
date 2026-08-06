/**
 * Data contracts for the bundled deep-research workflow.
 *
 * A contract earns structure only where deterministic code (a task, lift, or
 * fanout) reads a field. Everything that merely travels from one agent to the
 * next is prose: deterministic code never interprets the lane reports, the
 * skeptic's review, or the writer's publication draft, so forcing them into
 * nested arrays would tax the agent for no runtime benefit and invite long-array
 * and deep-nesting failures. The only structured fields below are the joints
 * code actually destructures: lane titles for deduplication and fanout, and the
 * gap loop's stop signal.
 */
import { z } from "acpus/core";

/** One independent investigation lane a single worker owns end to end. */
export const LaneSpec = z.object({
  title: z.string(),
  brief: z.string(),
});

export type LaneSpec = z.infer<typeof LaneSpec>;

export const LeadPlanOutput = z.object({
  researchBrief: z.string(),
  lanes: z.array(LaneSpec),
});

export const GapPlanOutput = z.object({
  sufficient: z.boolean(),
  coverage: z.string(),
  gaps: z.array(LaneSpec),
});

/**
 * One worker's self-contained investigation of a single lane. `laneTitle` is
 * the only structured joint (code deduplicates on it); `report` is the entire
 * compact evidence record as prose, keeping each finding, its evidence,
 * inference, confidence, and material caveat together while carrying figure
 * candidates and sources in whatever shape the lane calls for.
 */
export const LaneReport = z.object({
  laneTitle: z.string(),
  report: z.string(),
});

export type LaneReport = z.infer<typeof LaneReport>;
