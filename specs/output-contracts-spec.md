# Output Schema Specification

## Status

- Current implementation: current
- Source modules: `src/contracts/schema-dsl.ts`, `src/runtime/output-parser.ts`, `src/runtime/agent-task-retry.ts`
- Maintenance trigger: update this spec when changing schema DSL parsing, parser behavior, continuation retry behavior, prompt footer content, implicit runtime fields, or output failure semantics

## Purpose

Output schema handling defines parseable agent JSON and runtime-owned output metadata. Workflow-visible agent output shape is declared with `output.schema`; diagnostic schemas remain runtime-internal.

## Normative Requirements

- Workflow agent executables MAY declare `output.schema`.
- When `output.schema` is omitted, agent output MUST satisfy the default schema `{summary:string,data?:unknown}`.
- Declared `output.schema` MUST replace the default base schema for that executable.
- Runtime implicit fields MUST be merged into the declared or default schema.
- Gate agent output MUST include implicit `verdict`.
- Route agent output MUST include implicit `route`; route stages MUST NOT declare `output.schema`.
- Route agent implicit `route` prompt schemas and runtime validation MUST constrain `route` to the route stage's declared route IDs.
- Program tasks MUST NOT use `output.schema`.
- Program tasks MUST produce or be normalized to `{status,data}`.
- Program gate output MUST be normalized to `{status,summary,verdict,data?}`.
- Program fanin MUST produce `{status,data}`.
- Program fanin `mergeArrays` MUST concatenate `data` arrays from completed lane outputs in fanout order.
- If a completed lane output does not contain array `data`, program fanin MUST block with `PROGRAM_FANIN_INPUT_INVALID`.
- The schema DSL MUST support primitives, `unknown`, literals, arrays, objects, optional keys, and unions.
- The schema DSL MUST reject `any`, `Record`, and type aliases.
- Workflow output schema roots MUST be objects.
- Runtime parsing and continuation retry APIs MUST receive the compiled workflow output schema.
- Parsed object fields outside the declared schema MUST be rejected.
- Successful agent outputs MUST NOT receive a runtime-injected `status` content field.
- The parser MUST extract the final balanced JSON object from the complete agent response.
- The parser MUST ignore surrounding prose, Markdown code fences, semicolons, and trailing text around that final object.
- The parser MUST NOT treat arrays or primitive JSON values as workflow output candidates.
- If the final extracted object has invalid JSON syntax or fails schema validation, the parser MUST NOT fall back to earlier objects.
- The parser MUST NOT rename fields or normalize schema aliases before validation.
- Agent prompt footers MUST inject a single `# Final Output Contract` section containing the final effective schema rendered in a `typescript` code fence.
- Agent prompt footers MUST instruct the agent to respond only after completing its work.
- Task prompt text SHOULD NOT duplicate the final JSON object shape when `output.schema` already declares it.
- `OUTPUT_PARSE_FAILED` and `OUTPUT_SCHEMA_FAILED` MUST trigger an Agent Task Retry with reason `continuation` whenever shared retry budget remains.
- Continuation retry prompts MUST reuse the same session key and MUST contain only a short continue instruction, the previous failure code, and the final `# Final Output Contract`.
- Continuation retry prompts MUST NOT include the original prompt, raw output, best candidate, schema error details, or schema-fix hints.
- If retry budget is exhausted, output recovery MUST block with `AGENT_TASK_RETRY_EXHAUSTED`.

## Interfaces and Contracts

Example output schema declarations:

```yaml
output:
  schema: "{summary:string,data?:[{path:string,severity?:string}]}"
```

```yaml
output:
  schema: "{summary:string,verdict:\"pass\"|\"pass_with_warnings\"|\"blocked\"|\"failed\"|\"unknown\"}"
```

Gate verdicts MUST be one of `pass`, `pass_with_warnings`, `blocked`, `failed`, or `unknown`.

Route values MUST be one of the route stage's declared route IDs.

Prompt footers MUST include one bold instruction telling agents to respond only after completing the whole task, with exactly one valid parseable final JSON object, without a Markdown JSON code fence, starting with `{`, ending with `}`, and containing no prose, Markdown, or code fences.

Parser diagnostics include parse failure, schema failure, and final-object candidate information.

## Data Model

Output data includes the compiled DSL AST, parsed output, parse diagnostics, continuation prompt, blocked envelopes, runtime metadata, command metadata, and fanout `results` used as fanin input. Agent completion status is runtime metadata; program output `status` remains part of `{status,data}` program content.

## Runtime Behavior

The runtime records raw agent output, extracts the final balanced JSON object, validates the result against the executable output schema plus implicit fields, and writes parsed output artifacts. If parsing or validation fails, the runtime performs continuation retry through the unified Agent Task Retry engine until the shared work-unit retry budget is exhausted. If retry budget is exhausted, the executable blocks with structured diagnostics.

Program command output is normalized independently of the DSL. A command non-zero exit code is output data, not a blocking condition.

## Extension Points

New DSL constructs, implicit runtime fields, runtime-internal diagnostic payloads, and program fanin output shapes MAY be added when documented here and covered by tests.

## Non-Goals

- Workflow output shape is selected only with `output.schema`.
- No `any`, `Record`, or type alias support in workflow output schemas.
- No alias normalization during parser validation.
- No syntax correction, semantic correction, alias fallback, or field normalization before validation.

## Implementation Map

- Schema DSL -> `src/contracts/schema-dsl.ts`
- Runtime parsing -> `src/runtime/output-parser.ts`
- Agent Task Retry -> `src/runtime/agent-task-retry.ts`
