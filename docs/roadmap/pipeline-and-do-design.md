# Pipeline and `do` Design Proposal

This design has been adopted and implemented. Current behavior is described by
`specs/` (especially `specs/workflow-spec.md`). This document is retained as a
design-decision reference.

## Problem

Acpus currently has an implicit root pipeline: `workflow.steps` is an ordered
list of Nodes. Several Composite Nodes also contain ordered `do` lists:

- `fanout.do`
- `loop.do`
- `switch.cases[].do`
- `switch.default.do`

`parallel` is different. Its `parallel` list contains full child Nodes, but a
single parallel branch cannot directly contain multiple sequential steps unless
the author uses a `subworkflow`. That makes a small local sequence pay the cost
of a Workflow boundary: another file, child Workflow metadata, child outputs,
and different recovery semantics.

The deeper issue is that Acpus has sequence behavior but no explicit sequence
primitive in the author-facing Workflow Spec. The implicit root pipeline and
the various `do` bodies are separate surfaces for the same idea.

## Goals

- Add an explicit `pipeline` Node as the Workflow Spec primitive for ordered
  sequential execution.
- Treat every `do` list as inline syntax for a `pipeline`.
- Model every `parallel` entry as a branch descriptor with stable `id` and
  `do`; a single-step branch is a one-step `do` pipeline.
- Keep expression dependencies local: a later step depends on prior visible
  steps in the current pipeline scope, not on private child Nodes inside a
  sibling or parent Composite Node.
- Make Composite Node outputs read like public contracts, not execution-tree
  traversal.
- Preserve enough internal structure for TUI, artifacts, retry, fork, and
  debugging without forcing callers to depend on that structure.

## Non-Goals

- This proposal does not introduce DAG dependency syntax such as `runAfter`,
  `needs`, or arbitrary task graph edges.
- This proposal does not make sibling parallel branches visible to each other.
- This proposal does not make every internal child Node of a Composite Node
  part of the parent scope's public expression contract.
- This proposal does not replace `subworkflow`. Subworkflow remains the right
  tool for a reusable or file-separated Workflow boundary.

## Core Model

The Workflow Spec has these orthogonal composition ideas:

| Concept | Responsibility |
|---|---|
| `pipeline` | Execute child Nodes sequentially. |
| `parallel` | Execute child Nodes concurrently. |
| `fanout` | Execute one child pipeline per input item. |
| `loop` | Re-run one child pipeline until a condition or limit. |
| `switch` | Select one child pipeline from cases/default. |
| `do` | Inline shorthand for a child `pipeline`. |

The important split is:

- Runtime and TUI can preserve the full execution tree.
- Expression consumers depend on the public `output` of visible Nodes.

That means a parent step reads `steps.<node_id>.output`, not private nested
children several levels below it.

This is an intentional break from the current composite-output model. Current
Acpus preserves child step envelopes inside several Composite outputs, which
pushes authors toward paths such as:

```yaml
${{ steps.build.output.game.output.game_path }}
```

The proposed model makes each Composite Node expose its own primary output, so
the parent-facing path becomes:

```yaml
${{ steps.build.output.game.game_path }}
```

The internal child Nodes still exist for state, artifacts, TUI, retry, fork,
and diagnostics, but they are not the normal parent expression contract.

## Authoring Forms

### Explicit Pipeline

```yaml
- id: build_game
  pipeline:
    - id: create_game
      run: agent
      use: maker
      prompt: Create the game
      output:
        game_path: string

    - id: test_game
      run: agent
      use: tester
      prompt: Test ${{ steps.create_game.output.game_path }}
      output:
        game_path: string
        passed: boolean
```

Inside `build_game`, `test_game` can read `create_game` because it is a prior
visible sibling in the same pipeline.

Outside `build_game`, consumers read:

```yaml
${{ steps.build_game.output.game_path }}
${{ steps.build_game.output.passed }}
```

They do not read:

```yaml
${{ steps.build_game.output.create_game.output.game_path }}
```

### Pipeline Output Projection

By default, a pipeline's public output is the final child Node's primary output.
This is a deliberate authoring rule, not a warning condition. If an author adds
a trailing cleanup/control step and wants to preserve a previous public result,
they declare `outputs`.

When the author wants a stable public contract that differs from the final
child output, the pipeline can declare `outputs`.

```yaml
- id: build_game
  pipeline:
    - id: create_game
      run: agent
      use: maker
      prompt: Create the game
      output:
        game_path: string

    - id: test_game
      run: agent
      use: tester
      prompt: Test ${{ steps.create_game.output.game_path }}
      output:
        passed: boolean

  outputs:
    game_path: ${{ steps.create_game.output.game_path }}
    passed: ${{ steps.test_game.output.passed }}
```

Then later Nodes read:

```yaml
${{ steps.build_game.output.game_path }}
${{ steps.build_game.output.passed }}
```

This keeps the pipeline's internal structure private while allowing an explicit
public contract.

### Root Workflow Pipeline

The implicit root pipeline created from `workflow.steps` keeps its current
Workflow-level role: it collects direct top-level step values so top-level
`outputs` can be evaluated after the Workflow completes.

That implicit root pipeline is not the same public interface as an author-written
`pipeline` Node. Author-written `pipeline` Nodes use the primary-output rule
above. The root pipeline remains the Workflow execution container and exposes
the completed top-level step context for Workflow output projection.

### `parallel` Branches

Every `parallel` entry is a branch descriptor. The branch `id` names the branch
scope and the parent-visible output key. The branch body is `do`, which is an
inline pipeline.

```yaml
- id: build
  parallel:
    - id: game
      do:
        - id: create_game
          run: agent
          use: maker
          prompt: Create the game
          output:
            game_path: string

        - id: test_game
          run: agent
          use: tester
          prompt: Test ${{ steps.create_game.output.game_path }}
          output:
            game_path: string
            passed: boolean

    - id: docs
      do:
        - id: draft_docs
          run: agent
          use: writer
          prompt: Draft docs
          output:
            docs_path: string

        - id: review_docs
          run: agent
          use: reviewer
          prompt: Review ${{ steps.draft_docs.output.docs_path }}
          output:
            docs_path: string
            approved: boolean
```

Parent consumers read branch public outputs:

```yaml
${{ steps.build.output.game.game_path }}
${{ steps.build.output.game.passed }}
${{ steps.build.output.docs.docs_path }}
${{ steps.build.output.docs.approved }}
```

The parent does not depend on `create_game`, `test_game`, `draft_docs`, or
`review_docs` as public expression names.

A single-step branch still uses `do`; it is just a one-step pipeline.

```yaml
- id: checks
  parallel:
    - id: lint
      do:
        - id: run_lint
          run: program
          cmd: pnpm lint

    - id: typecheck
      do:
        - id: run_typecheck
          run: program
          cmd: pnpm typecheck
```

### `do` In Other Composite Nodes

Existing `do` sites become syntax for a child pipeline.

```yaml
- id: each_package
  fanout:
    over: steps.plan.output.packages
    do:
      - id: prepare
        run: program
        cmd: pnpm install

      - id: build
        run: program
        cmd: pnpm build
        capture:
          from: stdout
          parse: json
        output:
          artifact_path: string
```

Each lane's public result is the inline pipeline output. With the default
pipeline rule, that is `build.output`.

## Desugaring

Every `do` list desugars to a `pipeline` Node before runtime execution.

Conceptually:

```yaml
do:
  - id: a
    run: program
    cmd: echo a
  - id: b
    run: program
    cmd: echo b
```

becomes:

```yaml
pipeline:
  - id: a
    run: program
    cmd: echo a
  - id: b
    run: program
    cmd: echo b
```

Compiler diagnostics need to retain source-location information precise enough
to point at the original `do` field and child step paths.

`do` desugaring introduces an internal pipeline container even where the current
IR stores body children directly under `fanout`, `loop`, or `switch`. That is an
observable implementation change for Node Keys, TUI hierarchy, retry/fork
planning, and output projection. The accepted design treats that change as part
of making `pipeline` the single sequence primitive.

For stable runtime identity, a desugared pipeline needs a stable internal id.
Candidate naming:

- `workflow` keeps the root pipeline id.
- Explicit `pipeline` Nodes outside `parallel` use the author-provided Node `id`.
- A `parallel` branch descriptor uses the branch `id` as the pipeline Node id
  and branch output key.
- `fanout.do`, `loop.do`, and `switch` case/default `do` use a generated
  internal id derived from the parent Node id and body position, while keeping
  diagnostics mapped to the source `do` path.

Example conceptual hierarchy:

```text
build [parallel]
  game [pipeline, source: parallel[0].do]
    create_game [agent]
    test_game [agent]
```

## Expression Visibility

Expression visibility follows lexical execution scope:

- A pipeline child sees inherited visible Nodes from the parent scope.
- A pipeline child sees earlier siblings in the same pipeline.
- A pipeline child does not see later siblings in the same pipeline.
- A pipeline child inside a parallel branch does not see child Nodes inside
  sibling parallel branches.
- A parent scope sees the Composite Node as a Node and reads its public output.
- A parent scope does not see private child step ids inside a Composite Node.

Example:

```yaml
- id: build
  parallel:
    - id: game
      do:
        - id: create_game
          run: agent
          output:
            game_path: string

        - id: test_game
          run: agent
          prompt: ${{ steps.create_game.output.game_path }}
          output:
            game_path: string

- id: package
  run: agent
  prompt: ${{ steps.build.output.game.game_path }}
```

`test_game` can see `create_game`. `package` can see `build`, and reads the
public `game` branch output. `package` does not read `create_game` directly.

This changes current Acpus visibility behavior. Today, some Composite descendant
step ids leak into later sibling scopes. The proposed model removes that leak:
Composite internals are visible within their own pipeline scope and observable
through runtime inspection, but not inherited as parent-scope expression names.

## Scope Frames

The runtime needs explicit step-context frames to make the visibility contract
match execution:

- Entering a pipeline creates a child step frame seeded from inherited visible
  parent steps.
- Each pipeline child writes its completed output into the current pipeline
  frame.
- When the pipeline completes, only the pipeline Node's public output is written
  back to the parent frame under the pipeline Node id.
- Entering a parallel branch creates an isolated branch frame seeded from the
  parent visible steps.
- Sibling parallel branches never share frame mutations.
- `fanout`, `loop`, and `switch` execute their `do` bodies through the same
  pipeline-frame mechanism.

This replaces the current flat `ctx.steps` sharing in body execution. Runtime
inspection can still read every materialized child Node state from the Run
store; expression evaluation gets only the visible frame.

## Output Semantics

### Primary Output

Every Node has a public primary output at:

```yaml
steps.<id>.output
```

For Agent, Program, and Signal Nodes, this is their produced output object.

For `pipeline`, the default primary output is the final child Node's primary
output.

For `pipeline` with `outputs`, the primary output is the evaluated projection.

### Composite Outputs

Composite Nodes compose child primary outputs:

| Node kind | Public output |
|---|---|
| `pipeline` | Final child primary output, or `outputs` projection when declared. |
| `parallel` | Object keyed by branch id, each value is the branch child primary output. |
| `fanout` | Array of successful lane pipeline primary outputs. |
| `loop` | Final iteration pipeline primary output. |
| `switch` | Selected case/default pipeline primary output. |
| `subworkflow` | Referenced Workflow's top-level `outputs`. |
| `guard` | Guard result object. |

This deliberately avoids exposing nested child step envelopes as the normal
dependency surface.

### Guard Outputs

Guard Nodes can be the final child of a pipeline. In that case, the pipeline's
default public output is the Guard output object, such as `{ matched, action }`.
If that is not the author's intended public contract, the pipeline declares
`outputs` and projects the desired fields from earlier visible steps.

### Branch IDs

Parallel branches need stable `id` values. Without stable branch ids,
parent-visible output would need index keys or generated names, which is
brittle under branch reordering.

Candidate rule:

- A `parallel` entry is a branch descriptor with `id` and `do`.
- The branch `id` is the branch output key.
- Anonymous branches are rejected.
- A single-step branch is represented as a branch descriptor whose `do` contains
  one child step.

### Program Exit Codes

Program Steps still expose `steps.<id>.exit_code` inside the scope where that
Program Step is visible.

Pipeline and Composite public outputs do not automatically re-expose child
`exit_code` fields. If an exit code is part of the public contract, the author
projects it explicitly:

```yaml
- id: verify
  pipeline:
    - id: test
      run: program
      cmd: pnpm test
  outputs:
    exit_code: ${{ steps.test.exit_code }}
```

## Guard, Failure, And Cancellation Semantics

### Guard Completion

A Guard Node action of `complete` completes the current pipeline scope. It does
not complete unrelated sibling parallel branches, fanout lanes, or parent
Workflow scopes unless the guard itself is in that parent scope.

### Pipeline Failure

A pipeline runs children sequentially. If a child fails and its own error policy
does not resolve the failure, the pipeline fails and later children do not run.

### Parallel Failure

Parallel join semantics stay owned by `parallel`:

- `join: all` keeps fail-fast behavior.
- `join: race` keeps first-completer behavior.
- Cancellation from a failed branch is anchored at the `parallel` instance and
  cancels active descendants of sibling branches.

If a branch pipeline fails after some child Nodes completed, those child Node
states and artifacts remain visible in runtime/TUI inspection, but the parent
expression contract is the failed branch Node, not the intermediate child
outputs.

## Runtime And Node Keys

The runtime still materializes internal Nodes for recovery, artifacts, telemetry,
fork, retry, and visualization.

Example conceptual Node Keys:

```text
workflow/build
workflow/build/game/branch:0
workflow/build/game/create_game/branch:0
workflow/build/game/test_game/branch:0
workflow/build/docs/branch:1
workflow/build/docs/draft_docs/branch:1
workflow/build/docs/review_docs/branch:1
```

The exact encoding can follow the existing Node Key strategy, but it needs to
preserve enough hierarchy for:

- sibling branch disambiguation,
- nested Composite disambiguation,
- TUI grouping,
- cancellation scoped to a Composite instance,
- fork/retry inheritance.

## TUI Shape

The planned TUI shape shows the real hierarchy:

```text
build [parallel]
  game [pipeline]
    create_game [agent]
    test_game [agent]
  docs [pipeline]
    draft_docs [agent]
    review_docs [agent]
```

The TUI shape avoids flattening branch pipeline children directly under the parallel node,
because that makes branch-local scope look like parent scope.

## Schema And Compiler Impact

Planned schema additions:

- Add `pipelineStep` as a first-class Node kind.
- Add `outputs` projection to `pipelineStep`.
- Allow `do` as a pipeline shorthand in Composite body positions.
- Change `parallel` entries to branch descriptors with `id` plus `do`.
- Reject a Node that declares both `pipeline` and `do`.
- Reject anonymous parallel branches.

Compiler work:

- Normalize `do` into pipeline IR while retaining source paths for diagnostics.
- Add `pipeline` to the shared composite contract.
- Thread expression visibility sequentially through pipeline children.
- Keep parallel branch sibling isolation.
- Evaluate pipeline `outputs` projection after the pipeline body completes.
- Project Composite outputs from child primary outputs, not child envelopes.

## Runtime Impact

Runtime work:

- Execute pipeline children sequentially.
- Persist pipeline Node state and output like other Composite Nodes.
- Ensure `do`-generated pipeline Nodes have stable keys.
- Preserve child artifacts and telemetry for inspection.
- Keep fail-fast and cancellation roots scoped to the owning Composite instance.
- Ensure fork/retry inheritance understands pipeline hierarchy.

## Verification Plan

The design needs representative Workflow Spec tests before promotion to
`specs/`.

### Positive Fixtures

- Explicit top-level `pipeline`.
- `parallel` with multi-step `do` branches.
- `parallel` with one-step `do` branches.
- `fanout.do` as inline pipeline.
- `loop.do` as inline pipeline.
- `switch.cases[].do` and `switch.default.do` as inline pipelines.
- Pipeline `outputs` projection that exposes an intermediate child value.

### Scope Fixtures

- A later pipeline child can read an earlier child.
- A parent can read a Composite Node's public output.
- A parent cannot directly depend on private child step ids inside a parallel
  branch pipeline.
- A sibling parallel branch cannot read another branch's child step.
- A pipeline child cannot read a later sibling.

### Output Fixtures

- Pipeline default output equals final child primary output.
- Pipeline `outputs` overrides the default output with a projection.
- Parallel output is keyed by branch id and contains branch primary outputs.
- Fanout output is an array of lane pipeline primary outputs.
- Loop output is the final iteration pipeline primary output.
- Switch output is the selected branch pipeline primary output.

### Failure Fixtures

- Branch pipeline fails in its first child.
- Branch pipeline fails in its second child after the first child emits output.
- `parallel join: all` cancels long-running sibling branch descendants on branch
  pipeline failure.
- `parallel join: race` completes from the first completed branch pipeline.
- Guard `complete` inside a branch pipeline completes only that branch pipeline.

### TUI And Recovery Fixtures

- TUI renders parallel lanes with nested pipelines and child Nodes.
- Node Keys remain unique for nested parallel/pipeline/fanout/loop combinations.
- Retry/fork inheritance handles completed pipeline children and failed pipeline
  descendants without crossing Composite instance boundaries.

## Open Questions For Review

- Should `pipeline.outputs` use the name `outputs` to mirror top-level outputs,
  or a different field to avoid confusion with top-level Workflow projection?
- Should explicit `pipeline` be allowed anywhere a full Node is allowed, or only
  where a sequence is currently needed?
- Does existing `fanout.do` / `loop.do` / `switch.do` output behavior change
  immediately to the pipeline primary-output model, or does the implementation
  first verify that current behavior already matches closely enough?
- Should parent-scope expression validation actively reject direct references to
  private child ids, or rely on the visible-step model to make those ids absent?

## Adoption Path

1. Review this roadmap design and settle the open questions.
2. Build validation fixtures that compare status quo subworkflow, explicit
   pipeline, and `do` shorthand.
3. Update `specs/workflow-spec.md` and `specs/local-runtime-target-spec.md`.
4. Update schema/compiler/runtime/TUI behavior.
5. Add contract, integration, runtime, and TUI tests.
6. Update skill references and examples after the spec becomes current truth.
