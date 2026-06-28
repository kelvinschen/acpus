# Core AI Ergonomics Roadmap

This roadmap tracks unresolved AI/LLM authoring ergonomics candidates for
`@acpus/core`. Current implemented behavior lives in `specs/`; completed review
notes and old API examples are intentionally not repeated here.

## Selection Criteria

- Prefer changes that prevent high-frequency LLM authoring mistakes.
- Keep helpers broad and familiar rather than adding one-off DSLs.
- Prefer TypeScript contracts for TS-visible mistakes; use validator diagnostics
  only where TypeScript cannot help.
- Avoid compatibility shims while the core is unpublished.

## Open Candidates

### Preserve Agent Key Literals For Extracted Agent Maps

When authors inline `agents` in `defineWorkflow(...)`, TypeScript can infer
literal agent keys and type-check `run.agent`. When authors extract the object
and annotate it as a broad `AgentMap`, keys widen to `string` and the key check
is lost.

```ts
// Loses literal keys.
const agents: AgentMap = {
  reviewer: { use: "codex" },
};

// Keeps literal keys today.
const agents = {
  reviewer: { use: "codex" },
} satisfies AgentMap;
```

Candidate direction: consider a tiny `defineAgents({...})` helper only if
examples and docs are not enough to keep authors on `satisfies AgentMap`.

### Structured Diagnostics For Non-Typechecked Authoring Paths

The intended workflow authoring path is TypeScript typecheck first, then compile
and validate `WorkflowIR`. Some recovery loops still need better structured
diagnostics when code reaches the compiler through JavaScript, `any`, generated
modules, malformed dynamic imports, or helper misuse that TypeScript cannot
see.

Candidate direction: keep strengthening compiler diagnostics for malformed
authoring objects and module-loading failures. Helper misuse that is visible to
TypeScript should stay type-only.

### Runtime Prompt Rendering Policy Implementation

The spec records the prompt rendering policy: template expression parts that
evaluate to objects or arrays should render as stable pretty JSON, primitive
values should stringify predictably, and artifact/secret rendering belongs to
runtime policy. The authoring API intentionally does not add `json(...)` or
`text(...)` helpers.

Candidate direction: implement this policy in the future Agent and Signal
runtime renderers, not in the core authoring layer.

### Additional Lodash-Style Collection Helpers

The current public helpers include `head(...)`, `nth(...)`, `includes(...)`, and
`isEmpty(...)`. Future real workflows may justify more lodash-style helpers, but
each should be added only when it represents a common collection concept and
lowers to a stable expression form.

Candidate direction: evaluate candidates such as `last(...)` only after repeated
usage appears in fixtures or runtime workflows.
