# Specification Maintenance Guide

This guide defines how Acpus maintains product specifications. It complements
the spec template and catalog in
[`specs/INDEX.md`](../specs/INDEX.md); it does not define product behavior.

The maintenance goal is a small, navigable set of current contracts. A spec is
not a changelog, proposal, implementation diary, or compatibility record.

## Document Roles

| Content | Canonical location |
| --- | --- |
| Current implemented product and design contract | `specs/` |
| Future work, capability gaps, and active implementation goals | `docs/roadmap/` |
| Completed plans, previous implementations, and line-by-line evolution | Git history and release tags |

## Route a Change Before Writing

Use this decision tree before adding or editing a spec:

1. **Does the change alter current observable behavior?** Observable behavior
   includes authoring APIs, accepted inputs, diagnostics, IR, persistence,
   runtime semantics, CLI output, hooks, and operator-facing projections.
   - **Yes:** edit the existing spec that owns that behavior. Update its
     verification in the same change.
   - **No:** continue to question 2.
2. **Is it a behavior-preserving refactor?**
   - Do not add a requirement or a new spec.
   - Update a spec only if an implementation reference, ownership boundary, or
     verification command became stale.
   - Record an unusually important architectural choice as a roadmap/design
     record, then remove that record when the current spec captures the lasting
     decision. Git history preserves the implementation context.
3. **Is it a bug fix?**
   - If implementation violates an existing spec, fix implementation and add
     the missing regression test. Do not rewrite the contract to match the bug.
   - If the intended behavior was absent or ambiguous, clarify the owning spec
     and add verification in the same change.
4. **Does it remove behavior?**
   - Delete or replace the obsolete current requirement and its obsolete tests.
   - Do not leave migration warnings, legacy-field diagnostics, or historical
     tombstones in the current spec.
   - Describe a transition only when compatibility is deliberately part of the
     current product and was explicitly requested. Give it an owner, exit
     condition, and removal date.
5. **Is it future work or a known gap?** Put it in `docs/roadmap/`, not in a
   spec. Remove the record after the current spec and implementation converge.
6. **Is it history, rationale, benchmark evidence, or a handoff?** Keep it in
   Git history. Link it from a spec only when it is needed to understand the
   current boundary.

Create a new spec only for a distinct, stable behavior boundary with a clear
owner and independent verification. A new use case inside an existing boundary
usually belongs in the owning spec.

## One Canonical Owner

Every behavior has one canonical owner spec, normally the package that defines
the public contract. Other specs may describe the boundary they own and link to
the canonical requirement; they must not restate its details.

For a cross-package flow:

- the producer owns the shape and guarantees of its output;
- the consumer owns how it interprets that input;
- the runtime or integration owner owns the end-to-end ordering and failure
  semantics that are not local to either side;
- delegating specs link to the owner instead of copying requirements.

When ownership is unclear, resolve it before writing. Duplicating the rule in
both specs creates two apparent sources of truth and makes future edits unsafe.

## Write Atomic Normative Requirements

Specs use the RFC 2119 and RFC 8174 meanings of `MUST`, `SHOULD`, and `MAY`.
Use those keywords deliberately:

- `MUST` expresses a required invariant or externally relied-on contract.
- `SHOULD` requires a real, understood exception. State that exception or use
  `MUST` or ordinary descriptive prose instead.
- `MAY` describes a supported option. It does not mean planned work or author
  preference.
- Lowercase words such as "should" have their ordinary prose meaning.

Each normative statement should contain one independently testable obligation.
Name the responsible subject, the triggering condition, and the observable
result. Split combined validation, diagnostic, persistence, and ordering rules
into separate statements. Use a stable heading anchor or requirement identifier
when verification needs to refer to an individual obligation.

Avoid vague outcomes such as "robust", "fast", "user-friendly", or "correct"
unless the spec provides an observable threshold or oracle.

Bad:

```md
- The compiler MUST reject dynamic IDs and SHOULD return a useful diagnostic
  with a path and source location.
```

Better:

```md
- The compiler MUST reject a node ID that cannot be determined during graph
  construction.
- For a rejected node ID, the diagnostic MUST identify the authoring path.
- When source mapping is available, the diagnostic MUST include the source
  location of the rejected ID.
```

Negative requirements are useful only when they define a current closed shape,
safety boundary, or unsupported input. They must not exist solely to memorialize
removed behavior.

## Keep Examples Informative

Every example in a spec must be explicitly introduced by an
`### Informative Example` heading, or `### Informative Examples` when one
heading groups several examples. An example illustrates requirements already
stated in the normative prose; it does not introduce additional accepted
syntax, defaults, error behavior, or ordering.

When an example reveals a missing rule, add an atomic requirement first. Do not
put `MUST`, `SHOULD`, or `MAY` in examples, diagrams, notes, or appendices. Link
lengthy tutorials and operational recipes from the spec instead of embedding
them.

## Verification Rules

- Every normative requirement needs a verification method: a focused automated
  test, a structural check, or an explicit manual inspection when automation is
  not practical.
- Prefer the lowest stable layer and an exact observable oracle. A unit or
  contract test is preferable to a full CLI run for a pure lowering rule.
- The spec's `Verification` section and its entry in `specs/INDEX.md` must name
  commands that exercise the current contract.
- Add or update verification in the same change as the behavior and spec.
- A removal deletes tests whose only purpose was to preserve or reject removed
  behavior. Retain tests only for boundaries that remain current.
- Generated reference data should come from its canonical schema or code source
  when practical; do not maintain two editable copies.
- Do not claim verification from a test that checks only setup, snapshots an
  unstable whole object, or asserts the agent's narration instead of the actual
  repository or runtime outcome.

## Review Checklist

Before approving a spec change, verify:

- [ ] The change is routed to current contract, future plan, or Git history
      according to its role.
- [ ] The relevant existing owner spec was considered before a new file was
      created.
- [ ] Each behavior is normative in one place; delegating specs link to it.
- [ ] Removed or superseded wording was deleted instead of accumulated.
- [ ] Each BCP 14 statement is atomic, necessary, unambiguous, and observable.
- [ ] `SHOULD` has a meaningful exception and `MAY` describes current support.
- [ ] Examples are informative and introduce no unstated behavior.
- [ ] Verification covers typical, boundary, and failure behavior at the lowest
      stable layer.
- [ ] Code, tests, specs, indexes, and local links agree in the same change.
- [ ] The final diff was reviewed for opportunities to merge, shorten, or
      delete existing text before accepting net growth.

## Agent Smoke Scenarios

Use these scenarios after changing spec structure, indexes, or agent
instructions. Evaluate the files changed and tests selected, not the agent's
self-report.

1. **Behavior-preserving rename:** ask the agent to rename an internal helper.
   It should not add a requirement or spec; it should update only genuinely
   stale references.
2. **Implementation bug:** provide code that contradicts an existing contract.
   The agent should find the owner spec, fix the code, and add a regression test
   without redefining the intended behavior.
3. **Future capability:** ask for a design that is not implemented. The agent
   should create or update an active roadmap record, not claim it in `specs/`.
4. **Behavior removal:** remove a CLI field or authoring form. The agent should
   delete its current requirements and obsolete tests without adding a
   compatibility tombstone.
5. **Cross-package contract:** change a value that crosses package boundaries.
   The agent should update the canonical owner and use links or delegation in
   related specs rather than copying the rule.
6. **Misleading example:** give an example that implies an unstated default.
   The agent should either add and verify a normative requirement or correct the
   example; it should not treat the example alone as the contract.
7. **Hook domain change:** change a hook lifecycle or domain rule. The agent
   should update the Hooks owner spec, and update CLI only when its presentation
   or error mapping changes; it should not duplicate the hook rule in CLI.
8. **Closed-set addition:** add a member to `ResultPhase`. The exported
   TypeScript union should remain the canonical member list, the owning spec
   should define the closed-set semantics and failure behavior, and contract
   verification should prevent the CLI spec and type from drifting.
9. **Historical conflict:** provide an older-tag plan that disagrees with a
   current spec. The agent should follow the current spec and treat the older
   record only as historical design context.

Include normal, boundary, and conflicting-instruction variants. A successful
smoke run finds the right source, makes the smallest contract change, and picks
the relevant verification command.

## Growth Is a Review Signal

Track spec file count, lines or tokens, normative statement count, net additions
and deletions, unverified requirements, orphan files, and duplicate candidates.
Use trends to trigger owner review and periodic consolidation.

Automated spec checks and growth reports are advisory only. They surface broken
links, index drift, unusual structure, and growth patterns for review, but they
must not block a change or replace maintainer judgment. The operating
constraints come from `AGENTS.md`; when a report conflicts with a clearer,
smaller contract, follow the instructions and record the reasoning rather than
optimizing for the tool.

## Maintenance Cadence

Update current specs with the implementation change. Periodically review each
domain to merge duplicates, delete obsolete clauses and completed plans, and
verify links and commands. Prefer a smaller accurate contract over a large
partially current record.

## References

- [RFC 2119: Key words for use in RFCs to Indicate Requirement Levels](https://www.rfc-editor.org/rfc/rfc2119)
- [RFC 8174: Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words](https://www.rfc-editor.org/rfc/rfc8174)
- [IESG Statement on Clarifying the Use of BCP 14 Key Words](https://datatracker.ietf.org/doc/statement-iesg-statement-on-clarifying-the-use-of-bcp-14-key-words/)
- [Diátaxis: Reference](https://diataxis.fr/reference/)
- [UK Government Digital Service: Architecture Decisions](https://gds-way.digital.cabinet-office.gov.uk/standards/architecture-decisions.html)
- [OpenAI: Harness Engineering](https://openai.com/index/harness-engineering/)
- [Anthropic: Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
