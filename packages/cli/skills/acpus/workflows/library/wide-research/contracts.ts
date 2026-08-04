/** Shared schemas for the bundled wide-research workflow. */
import { z } from "acpus/core";

const Confidence = z.enum(["high", "medium", "low"]);
const SourceKind = z.enum(["web", "local", "other"]);

const Source = z.object({
  kind: SourceKind,
  locator: z.string(),
  title: z.string(),
  note: z.string(),
});

const RubricField = z.object({
  name: z.string(),
  description: z.string(),
});

const DiscoveryLane = z.object({
  title: z.string(),
  focus: z.string(),
  boundary: z.string(),
  approach: z.string(),
});

/** The shared frame and discovery partition for one wide investigation. */
export const LeadPlanOutput = z.object({
  researchBrief: z.string(),
  coverageUnit: z.string(),
  rubric: z.array(RubricField),
  discoveryLanes: z.array(DiscoveryLane),
});

const CandidateUnit = z.object({
  title: z.string(),
  locator: z.string(),
  kind: z.string(),
  scope: z.string(),
  selectionCase: z.string(),
  startingSources: z.array(Source),
});

/** Candidate coverage units found by one independent discovery Agent. */
export const DiscoveryOutput = z.object({
  laneTitle: z.string(),
  candidates: z.array(CandidateUnit),
  gaps: z.array(z.string()),
});

const CoverageUnitDraft = z.object({
  title: z.string(),
  locator: z.string(),
  kind: z.string(),
  scope: z.string(),
  researchObjective: z.string(),
  selectionReason: z.string(),
  startingSources: z.array(Source),
});

/** The curator's final, evidence-grounded coverage selection. */
export const CoveragePlanOutput = z.object({
  coverage: z.string(),
  units: z.array(CoverageUnitDraft),
});

const FieldResult = z.object({
  field: z.string(),
  status: z.enum(["supported", "partial", "unavailable"]),
  value: z.string(),
  support: z.string(),
  confidence: Confidence,
});

const Finding = z.object({
  statement: z.string(),
  support: z.string(),
  confidence: Confidence,
});

const Dataset = z.object({
  title: z.string(),
  note: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

/** One researcher's self-contained record for one coverage unit. */
export const CoverageRecord = z.object({
  unitId: z.string(),
  title: z.string(),
  status: z.enum(["complete", "partial", "unresolved"]),
  summary: z.string(),
  fields: z.array(FieldResult),
  notableFindings: z.array(Finding),
  datasets: z.array(Dataset),
  sources: z.array(Source),
  caveats: z.array(z.string()),
  confidence: Confidence,
});

const SynthesisPoint = z.object({
  statement: z.string(),
  support: z.string(),
  unitIds: z.array(z.string()),
  sourceLocators: z.array(z.string()),
  confidence: Confidence,
});

/** One Agent's provenance-preserving reduction of a bounded record batch. */
export const BatchSynthesis = z.object({
  title: z.string(),
  coverage: z.string(),
  patterns: z.array(SynthesisPoint),
  contrasts: z.array(SynthesisPoint),
  outliers: z.array(SynthesisPoint),
  datasets: z.array(Dataset),
  gaps: z.array(z.string()),
});
