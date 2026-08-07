/** Shared language instructions for agent-produced research evidence records. */
export const EVIDENCE_RECORD_PROMPT = String.raw`
#### Stay inside the record

- Write for downstream synthesis, not the final reader. Use compact factual
  prose. **NEVER** restate the assignment, add a general introduction, answer
  beyond this record's scope, or write a report-level conclusion.
- Use one stable term for each entity, concept, and action within the record.
  Record source aliases once and preserve meaningful differences. Keep exact
  identifiers, code, quotations, and source names in their original form.

#### Make each finding reusable

- **ALWAYS** give each material finding or evidence field its own paragraph or compact
  subsection. Keep the finding, its supporting source or dataset ids, any
  inference, calibrated confidence, and material caveat together. Keep exact
  locators and reusable values in the structured evidence attachments. Make
  observation and inference distinguishable in ordinary wording.
- Prefer an explicit subject and direct verb. Avoid ambiguous pronouns, dense
  noun chains, and sentences that merge independent claims. Use a list only for
  real parallel items, conditions, or steps.
- Preserve exact values, units, definitions, populations, denominators, and time
  ranges. **NEVER** compare incompatible definitions. Put reusable parallel values in
  a structured dataset; use a Markdown table in prose only when the local
  finding itself cannot be understood without that comparison.
- When the record examines a codebase or technical mechanism, preserve the
  explanatory building blocks the writer will need: the entry point, inputs,
  transformations, state authority, outputs, side effects, failure conditions,
  and meaningful branches. Trace an actual path at function level when the
  evidence permits it, and distinguish what source code, configuration, runtime
  observation, or inference separately establishes. Do not replace a trace with
  a directory or identifier inventory.

#### Stop when the evidence is usable

- Do not spend a separate pass polishing the record's voice. Completeness,
  semantic clarity, and traceability matter more.
`;
