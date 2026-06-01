# Output Contract Hardening

This implementation note has been superseded by the runtime orchestrator
refactor.

Output contracts now live in `src/contracts/` and are enforced at runtime:

- Zod schemas define the accepted contract shapes.
- Contract descriptors and examples are injected into prompts.
- `src/runtime/output-parser.ts` extracts, repairs syntactic JSON, normalizes
  deterministic aliases, and validates with the relevant Zod schema.
- `src/runtime/repair.ts` performs one schema-aware repair turn when an agent
  output cannot be parsed or validated.
- Repair failure returns a structured blocked envelope with
  `OUTPUT_REPAIR_FAILED`.

The maintained behavior is covered by unit tests in
`test/unit/output-parser-helper.test.ts` and runtime tests in
`test/e2e/fake/prepare-run.test.ts`.
