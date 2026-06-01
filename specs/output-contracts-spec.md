# Output Contracts Specification

## Status

- Current implementation: current
- Source modules: `src/contracts/`, `src/runtime/output-parser.ts`, `src/runtime/repair.ts`, `src/compiler/contracts.ts`
- Maintenance trigger: update this spec when changing output contract schemas, descriptors, examples, parser behavior, repair behavior, deterministic aliases, prompt footer content, or output failure semantics

## Purpose

Output contracts define the structured data agents must return and the runtime must validate. They make agent outputs parseable, repairable, reportable, and safe for downstream workflow stages.

## Normative Requirements

- Zod schemas in `src/contracts/` MUST be the source of truth for output contract shapes.
- Contract descriptors and examples MUST be injected into agent prompts through compiler/runtime prompt construction.
- Agent output SHOULD end with one plain JSON object matching the stage contract.
- The parser MUST select the last balanced JSON object from an agent response.
- The parser MUST tolerate non-JSON tail text after the selected JSON object.
- Fenced output parsing MUST handle nested markdown fences inside JSON strings by closing candidates only on a standalone closing fence line.
- Deterministic alias normalization MAY normalize explicitly supported aliases before schema validation.
- The runtime MUST allow at most one schema-aware repair turn for an invalid agent output.
- Repair turns MUST count in runtime usage accounting.
- `OUTPUT_PARSE_FAILED`, `OUTPUT_SCHEMA_FAILED`, and `OUTPUT_REPAIR_FAILED` MUST produce blocked attempt/stage/run state, not failed infrastructure state.
- Runtime output repair MUST NOT silently invent missing semantic content beyond supported deterministic normalization and explicit repair prompting.

## Interfaces and Contracts

Supported role-category contracts include:

- base output: generic status, summary, artifacts, next focus, and optional data;
- implementation output: changed files and checks;
- validation or review output: verdict, severity counts, findings, and checks;
- decision output: selected route and routing rationale for decision gates;
- discover output: discovered items under the stage output key, bounded by discover options when configured;
- summarize output: `finalVerdict`, deliverables, changed files, checks, warnings, risks, and next actions.
- diagnostic output: read-only recovery guidance, diagnostics, and next actions for diagnose flows.

Stage kinds select output contract names as follows:

- `decisionGate` selects `decision`;
- `discover` selects `discover`;
- `summarize` selects `summarization`;
- implementation roles select `implementation`;
- validation and review roles select `validation`;
- diagnostic runtime units select `diagnostic`;
- other stages select `base`.

Output parser diagnostics include parse failure, schema failure, candidate information, and repair failure codes suitable for report surfaces and Main Agent repair loops.

## Data Model

Output contract data includes contract schemas, descriptors, examples, repair hints, normalized parsed output, parse diagnostics, repair prompts, raw repair output, and blocked envelopes for unrepaired contract failures.

## Runtime Behavior

The runtime records raw agent output, extracts a candidate JSON object, repairs syntactic JSON when supported, normalizes deterministic aliases, validates the result against the stage Zod schema, and writes parsed output artifacts. If validation fails, the runtime performs one schema-aware repair turn and repeats parsing and validation. If repair fails, the stage is blocked with a structured diagnostic.

## Extension Points

New output contracts MAY be added by defining schema, descriptor, examples, repair hints, normalization rules, and compiler/runtime integration. New contract names MUST be documented here and in the error-code SPEC when they introduce new diagnostics. New deterministic aliases MUST be explicit and covered by contract normalization logic.

## Non-Goals

- Output contracts are not free-form natural-language summaries.
- Output repair is not a general semantic correction engine.
- Handwritten validators are not the main path.
- Contract changes MUST NOT be hidden only in prompt text.

## Implementation Map

- Contract schemas -> `src/contracts/schemas.ts`, `src/contracts/output-contracts.ts`
- Descriptors and examples -> `src/contracts/descriptors.ts`, `src/contracts/examples.ts`
- Repair hints -> `src/contracts/repair-hints.ts`
- Alias normalization -> `src/contracts/normalize.ts`
- Compiler contract selection -> `src/compiler/contracts.ts`
- Runtime parsing -> `src/runtime/output-parser.ts`
- Runtime repair -> `src/runtime/repair.ts`
