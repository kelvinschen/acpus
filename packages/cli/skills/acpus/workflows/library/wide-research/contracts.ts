/**
 * Data contracts for the bundled wide-research workflow.
 *
 * A contract earns structure only where deterministic code reads a field. The
 * corpus lift aggregates a coverage matrix and a deduplicated source index
 * across every record, so the fields it reads stay structured: unit identity
 * and status, per-rubric-field status, and each source. Everything else travels
 * agent to agent as prose. Discovery candidates, batch syntheses, and each
 * record's narrative (its summary, findings, comparison tables, and caveats)
 * never pass through code, so they are prose the agents write directly rather
 * than nested arrays that tax the agent for no runtime benefit.
 */
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

/** One discovery lane a single scout works alone. */
const DiscoveryLane = z.object({
  title: z.string(),
  brief: z.string(),
});

/** The shared frame and discovery partition for one wide investigation. */
export const LeadPlanOutput = z.object({
  researchBrief: z.string(),
  coverageUnit: z.string(),
  rubric: z.array(RubricField),
  discoveryLanes: z.array(DiscoveryLane),
});

/** One selected coverage unit; code assigns its unitId and reads only the count. */
const CoverageUnit = z.object({
  title: z.string(),
  brief: z.string(),
});

/** The curator's final, evidence-grounded coverage selection. */
export const CoveragePlanOutput = z.object({
  coverage: z.string(),
  units: z.array(CoverageUnit),
});

/**
 * One rubric field's coverage status for a record. The status feeds the
 * coverage matrix; the field's actual value and support live in the record
 * report prose.
 */
const FieldStatus = z.object({
  field: z.string(),
  status: z.enum(["supported", "partial", "unavailable"]),
});

/**
 * One researcher's record for one coverage unit. The structured fields are the
 * joints the corpus lift aggregates; `report` is a compact evidence record as
 * prose. It keeps rubric-field values and support, notable findings, inference,
 * confidence, and material caveats close enough for reliable reduction.
 */
export const CoverageRecord = z.object({
  unitId: z.string(),
  title: z.string(),
  status: z.enum(["complete", "partial", "unresolved"]),
  confidence: Confidence,
  fields: z.array(FieldStatus),
  sources: z.array(Source),
  report: z.string(),
});
