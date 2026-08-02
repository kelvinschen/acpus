/** Shared schemas and durable data contracts for the bundled deep-research workflow. */
import { z } from "acpus/core";

const Confidence = z.enum(["high", "medium", "low"]);
const Severity = z.enum(["high", "medium", "low"]);
const SourceKind = z.enum(["web", "local", "other"]);

/** One independent investigation lane a single worker owns end to end. */
export const LaneSpec = z.object({
  title: z.string(),
  objective: z.string(),
  boundary: z.string(),
  approach: z.string(),
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

const Finding = z.object({
  statement: z.string(),
  support: z.string(),
  confidence: Confidence,
});

/** A compact tabular dataset the writer can render as a table, chart, or diagram. */
const Dataset = z.object({
  title: z.string(),
  note: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

const Source = z.object({
  kind: SourceKind,
  locator: z.string(),
  title: z.string(),
  note: z.string(),
});

/** One worker's self-contained investigation of a single lane. */
export const LaneReport = z.object({
  laneTitle: z.string(),
  summary: z.string(),
  narrative: z.string(),
  findings: z.array(Finding),
  datasets: z.array(Dataset),
  sources: z.array(Source),
  caveats: z.array(z.string()),
  confidence: Confidence,
});

export type LaneReport = z.infer<typeof LaneReport>;

/** Advisory cross-check notes; they inform the writer but never gate or shape the report. */
export const SkepticNotesOutput = z.object({
  overall: z.string(),
  notes: z.array(z.object({
    target: z.string(),
    concern: z.string(),
    severity: Severity,
  })),
});
