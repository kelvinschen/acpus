/** Shared publication-strategy instructions for bundled research planners. */
export const PUBLICATION_STRATEGY_PROMPT = String.raw`
Plan the reader's route, not a generic report. Write the research brief as
compact, structured Markdown with exactly these
seven third-level sections: Reader outcome, Primary question, Explanatory
spine, Opening contract, Section arc, Evidence obligations, and Boundaries and
ending. Translate the heading labels into the research question's language when
needed, but preserve their meanings. The prose under each heading is a planning
contract for downstream researchers and the writer, not an answer to the
research question. **NEVER** turn it into a factual answer. Do not copy the later template-selection guidance into the
brief.

### Reader outcome

Name the primary reader, the decision or understanding the report must enable,
the knowledge the question permits you to assume, and, when material, the
practical consequence of getting the answer wrong. When several audiences are
named, identify their shared main path and the specialist detail that belongs in
reference material.

### Primary question

State the one question the report must resolve and the answer operation it calls
for: map, explain, compare, evaluate, diagnose, recommend, forecast, or provide a
durable reference. Preserve explicit secondary questions, but do not let them
compete with the primary one.

### Explanatory spine

Choose one stable relationship that will carry the reader from orientation to
understanding and action. Suitable spines include an object lifecycle, an
end-to-end trace, a causal chain, a decision process, a chronology, a user
journey, or a rule-to-impact chain. Describe the sequence in plain language.
**ALWAYS** make every main section advance this spine; secondary lenses must attach to it
rather than starting a second report.

### Opening contract

Require the opening to establish the direct answer or governing mental model and
only the scope boundary, uncertainty, or consequence that materially changes how
the reader should interpret it. Identify any genuinely parallel relationships
that may need a fast scan, but do not predict their answer or count before the
evidence is gathered. The writer may later choose a thesis alone, a thesis plus a
short labeled list, or a compact comparison or mapping. The opening is the
smallest useful orientation layer, not a checklist or a compressed report.

### Section arc

Describe how the main sections progressively advance the explanatory spine.
Order prerequisites before mechanisms, the common or normal path before
exceptions, and explanation before action. Keep inventories, audit trails, and
secondary context out of the main arc unless they change the answer.

### Evidence obligations

Name the evidence needed to support each decisive part of the arc, including
meaningful contrary evidence. Distinguish evidence classes that cannot substitute
for one another, such as source code, configuration, runtime observation,
benchmark, primary publication, regulation, market data, interview, or supported
inference. State where exact comparison, a worked trace, or a verification step
is required.

### Boundaries and ending

State what the report will not claim, what remains unknown, and the kind of
ending the reader needs: a conditional decision, recommendation, implementation
path, risk register, research gap, or durable operational reference.

Match the spine to the problem:

- **Codebase or implementation research:** establish repository and system
  boundaries, core objects and authority, then follow one representative task
  through entry points, transformations, state, side effects, feedback, and
  failure semantics. Explain variants as deltas from that trace. Require
  function-level evidence, distinguish code/configuration/runtime support, and
  include a worked change or diagnostic path when the reader must act on the
  code.
- **Technical selection:** move from goals and constraints to decision criteria,
  mechanism-level differences, comparable evidence, trade-offs, a conditional
  choice, and migration or exit implications. Do not plan a feature catalogue.
- **Architecture evolution:** move from current state and observed symptoms to
  structural causes and constraints, target properties, candidate paths, and a
  staged evolution with risks and verification.
- **Open-source ecosystem:** define the problem space and taxonomy, examine
  representative projects, maturity, health, fit, and integration cost, then
  narrow to a scenario-specific candidate set.
- **Performance or security evaluation:** begin with a workload or threat model,
  then connect measurements or attack paths to mechanisms, impact, remediation,
  and verification.
- **Policy or compliance:** connect governing text and applicability to concrete
  obligations, affected processes and controls, gaps, risk, owners, and actions.
- **Market or competitor research:** connect demand and change drivers to market
  structure, positions, product and commercial mechanisms, durable
  differentiation, scenarios, and action. Keep observed fact, estimate, and
  interpretation distinct.
- **Academic or frontier research:** move from the research question and a useful
  taxonomy to comparable methods and evidence, consensus, conflict, limitations,
  and genuine research gaps. Do not plan one section per paper.
- **Product or user research:** follow the user's goal and context through the
  journey, observed friction, causes, unmet needs, opportunities, priorities,
  and validation.
- **Internal knowledge or decision review:** for a review, connect the original
  context, known constraints, decision, execution, outcome, causal lesson, and
  reusable principle. For a reference, organize around domain concepts,
  canonical processes, decisions and exceptions, ownership, and unresolved
  questions.

For a mixed question, select the structure that best matches the reader's
primary outcome. Embed the other domain as an evidence lens at the relevant
points in that spine; **NEVER** concatenate several report templates.
`;
