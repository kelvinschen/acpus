# Workflow Spec

## Purpose

Workflow Specs are YAML documents that declare local durable workflows made of Agent Steps, Program Steps, Composite Nodes, Approval Gates, inputs, agents, and outputs.

## Requirements

- A Workflow Spec MUST be a YAML object.
- A Workflow Spec MUST declare `version`, `name`, and `workflow.steps`.
- `workflow.steps` MUST be an ordered list of Nodes.
- Every Node MUST declare a stable non-empty `id`.
- Node ids MUST be unique within the Workflow Spec after includes are expanded.
- A Workflow Spec MAY declare top-level `input`.
- A Workflow Spec MAY declare top-level `defaults`.
- A Workflow Spec MAY declare top-level `agents`.
- A Workflow Spec MAY declare top-level `outputs`.
- A Workflow Spec MAY declare `include` steps that are expanded at compile time.
- A started Workflow Run MUST execute a frozen IR snapshot and MUST NOT re-read mutable YAML during replay or resume.

### Agent Steps

- An Agent Step MUST use `run: agent`.
- An Agent Step MUST declare `use`.
- An Agent Step MUST declare `prompt`.
- An Agent Step MUST reference an agent declared under `agents`.
- An Agent Step MUST run against a local ACP-compatible agent through acpx.
- An Agent Step MAY omit `output` when no structured output parsing is required.
- An Agent Step MAY declare `output` using the Acpus Schema DSL defined in [Schema Spec](schema-spec.md).
- An Agent Step `output` declared with the Acpus Schema DSL MUST compile nested object and array item structure into the Agent Step output schema stored in the IR.
- An Agent Step MAY declare `output.schema` as a JSON Schema escape hatch.
- An Agent Step MUST declare `output` as an object when `output` is present.
- An Agent Step with `output` present MUST produce a JSON object that matches the declared output schema at `steps.<id>.output`.
- Agent output parse failures and schema failures MUST be handled as continuation retries when retry attempts remain.

### Program Steps

- A Program Step MUST use `run: program`.
- A Program Step MUST declare `cmd`.
- A Program Step MUST run as a local subprocess on the same host.
- A Program Step MAY declare `env`.
- A Program Step MAY declare `capture`.
- A Program Step MUST declare `capture` as an object when `capture` is present.
- Program Step `capture.from` MUST be `stdout` or `file`.
- Program Step `capture.parse` MUST be `json` or `text`.
- Program Step `capture.path` MUST be present when `capture.from` is `file`.
- A Program Step MUST expose `steps.<id>.exit_code`.
- A Program Step MUST expose stdout and stderr artifact references.
- Non-zero Program Step exit codes MUST be treated as step data unless the runtime contract explicitly marks the failure as non-recoverable.
- A Program Step MAY omit `capture` when no structured output parsing is required.

### Composite Nodes

- A `parallel` Node MUST contain named child Nodes.
- A `parallel` Node MUST produce a map keyed by branch id.
- A `parallel` Node MAY declare `join` as `all` or `race`.
- A `fanout` Node MUST declare `over`.
- A `fanout` Node MAY declare `key`.
- A `fanout` Node SHOULD declare `key` when items have stable identity.
- A `fanout` Node MAY declare `max_concurrency`.
- A `fanout` Node MAY declare `join` as `all`, `race`, or `quorum`.
- A `fanout` Node MUST declare `quorum` when `join: quorum` is used.
- A `fanout` Node MAY declare `success_criteria.min_success` as a positive integer.
- Node `join` MUST define the wait strategy, not the overall success criteria.
- `success_criteria.min_success` MUST define how many successful fanout lanes are required for overall fanout success after the wait strategy completes.
- A `fanout` Node MUST expose `item`, `item_id`, and `item_index` inside its body.
- A `switch` Node MUST select at most one branch.
- A `switch` Node MUST evaluate cases in order.
- A `switch` Node MAY declare a default branch.
- A `loop` Node MUST declare `max_iterations`.
- A `loop` Node MUST expose `loop.iter`.
- A `loop` Node MAY expose prior iteration output as `loop.last`.
- A `subworkflow` Node MUST reference another Workflow Spec path.
- A `subworkflow` Node MUST be awaited.

### Approval Gates

- An Approval Gate MUST declare `approval`.
- An Approval Gate MUST declare `prompt`.
- An Approval Gate MUST declare `timeout`.
- An Approval Gate MUST declare `on_timeout`.
- An Approval Gate MUST produce a JSON object that includes `approved`, `decision`, and `at`.
- Approval Gates MUST be distinct from operator pause.

### Expressions

- Expressions MUST use the `${{ ... }}` syntax.
- Expressions MUST be deterministic.
- Expressions MUST NOT perform external I/O.
- Expressions MUST NOT read wall-clock system time directly.
- Expressions MUST NOT use randomness.
- Expressions MAY read `input.*`.
- Expressions MAY read `steps.<id>.output.*`.
- Expressions MAY read `steps.<id>.exit_code`.
- Expressions MAY read fanout and loop scope variables when in scope.
- `now()` MUST be bound to the deterministic workflow clock.

### Local Runtime Boundary

- Workflow scheduling MUST be owned by Acpus.
- Agent session scheduling MUST be delegated to acpx.
- Program execution MUST be local subprocess execution.
- Workflow Specs MUST NOT require distributed execution semantics.
- Workflow Specs MUST NOT require remote worker routing.

## Verification

- Compiler tests MUST cover required top-level fields.
- Compiler tests MUST cover duplicate id diagnostics.
- Compiler tests MUST cover Agent Step shape validation.
- Compiler tests MUST cover Program Step shape validation.
- Compiler tests MUST cover composite Node compilation.
- Compiler tests MUST cover include expansion and include cycle diagnostics.
- Compiler tests MUST cover expression collection and validation.
- Compiler tests MUST cover output schema validation.
- Compiler tests MUST cover Agent Step output declarations that use the Acpus Schema DSL.
- Runtime tests MUST cover Agent Steps through acpx.
- Runtime tests MUST cover Program Steps as local subprocesses.
- Runtime tests MUST cover deterministic replay.
