import { z } from "acpus/core";

const EvidenceSource = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  locator: z.string(),
  supports: z.string(),
});

const EvidenceColumn = z.object({
  label: z.string(),
  unit: z.string().nullable(),
});

const EvidenceDataset = z.object({
  id: z.string(),
  title: z.string(),
  purpose: z.string(),
  columns: z.array(EvidenceColumn),
  rows: z.array(z.array(z.string())),
  timeBasis: z.string(),
  comparability: z.string(),
  derivation: z.string().nullable(),
  sourceIds: z.array(z.string()),
});

/** Exact acquisition data shared by research and publication Agents. */
export const EvidenceAttachments = z.object({
  sources: z.array(EvidenceSource),
  datasets: z.array(EvidenceDataset),
});

export const EVIDENCE_ATTACHMENTS_PROMPT = String.raw`
**ALWAYS** keep semantic findings in the prose record and put reusable acquisition data in
the structured sources and datasets fields.

- **ALWAYS** give every relied-on source one short id unique within this worker output.
  Record its kind, exact locator, title, and the finding or dataset it supports.
  In prose, cite the id where support matters; do not repeat the full source list.
- Add a dataset only when exact parallel values, a sequence, a mapping, or a
  derived comparison could be reused for synthesis or presentation. This is
  evidence, not a decision that the final report must contain a visual.
- Give every dataset one local id and state the reader question it could answer.
  Preserve exact row labels and values as strings. Put the unit on every column
  where it applies and state the time basis and comparability boundary once.
- Every dataset sourceIds entry must resolve to a source in this worker output.
  **NEVER** infer a missing value, mix incompatible definitions, or silently align
  different observation dates.
- Set derivation to null for observed values. For a derived result, state the
  exact inputs, operation, reported result, and unit compactly enough for the
  writer to inspect; never report a derived value without its inputs.
- Return empty sources or datasets arrays when the worker established none. **NEVER**
  create a decorative or speculative dataset merely to fill the structure.
`;
