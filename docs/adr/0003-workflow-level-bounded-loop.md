# Workflow-Level Bounded Loop

Status: accepted for planned implementation

We decided that planned workflow-level bounded retry and refinement flows should use a single `loop` stage kind. A loop is an explicit container with a scoped Loop Body, a required round limit, a canonical Loop Body Output, and a round-boundary continuation condition. The top-level workflow graph remains a DAG; ordinary top-level stages do not gain back edges.

This direction fully replaces the current `fixLoop` authoring and runtime shape as a breaking schema migration. Because the capability has not been released, the implementation should not preserve `fixLoop`, compile it as sugar, or add forward-compatibility logic.

**Considered Options**

- Generalize `fixLoop` in place by adding more validator and fixer steps.
- Allow ordinary top-level workflow stages to declare bounded back edges.
- Add a more explicit `boundedLoop` stage kind.
- Let a loop reference top-level stages as its body.
- Keep `fixLoop` as a compatibility layer or compile it into `loop`.
- Add dedicated parallel migration or parallel review stages for the target workflow.

**Consequences**

The first implementation should add `loop` as the only workflow-level cycle primitive and remove `fixLoop` from schema, linting, compilation, runtime execution, examples, tests, report projections, and specifications in the same change. This is intentionally a breaking migration.

Loop body stages should be inline and scoped to the loop container. The first version should allow existing recoverable non-terminal stage kinds in the body and should reject `gate`, nested `loop`, and new tool or program task kinds. Each Loop Round completes the full body before evaluating `continueWhen`; body stage blocked or failed status blocks the loop rather than acting as a control-flow signal.

Loop output and runtime state should preserve the container boundary. The top-level run index should contain one loop stage entry with nested round history rather than top-level entries for body stages. Loop output should expose the latest round summary, final outputs, and round metadata. Agent session keys should include loop id, round number, and body stage id so cross-round context is passed explicitly through loop variables rather than implicit conversation history.

Parallel migration workers and dual static/semantic review should be expressed with existing fanout and Lane Group semantics inside the Loop Body. The loop itself should not introduce another concurrency pool.

The implementation will require updates to workflow schema, generated JSON schema, compiler lint, execution planning, runtime scheduling, run-index state, resume behavior, report projections, examples, and the relevant specifications when the planned capability becomes current behavior.
