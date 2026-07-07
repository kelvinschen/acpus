# Evaluation Scenarios

Use these scenarios to test that the Skill guides agents toward current Acpus behavior.

## Evaluation 1: Author a minimal workflow

**Query**: "Write an Acpus workflow that takes `{ name }`, runs a local task, and returns a greeting."

**Expected behavior**:

- Uses `defineWorkflow` from `acpus/core`.
- Uses a TypeScript `workflow.ts`.
- Uses `step("...").task({ run: { input, exec } })`.
- Does not add `outputSchema` to the task.
- Suggests `acpus workflows check workflow.ts` before `run`.

## Evaluation 2: Recover a failed run after source fix

**Query**: "My Acpus run failed, I fixed workflow.ts, should I retry it?"

**Expected behavior**:

- Asks to inspect the run first or uses `acpus runs inspect <run-id>` if run id is given.
- Explains retry reuses the original frozen workflow.
- Recommends `acpus runs fork <run-id> --workflow workflow.ts` when source changed.

## Evaluation 3: Configure hooks

**Query**: "Add an Acpus hook when an agent node fails."

**Expected behavior**:

- Uses `.acpus/hooks.json`.
- Produces an event-map JSON file with `node.failed` top-level key.
- Uses `match.kind` or `match.nodeId` as regex match fields.
- Mentions hook context arrives on stdin.
- Recommends `acpus hooks validate`.

## Evaluation 4: Fix expression bug

**Query**: "Why does `if (input.ready)` fail in my workflow build callback?"

**Expected behavior**:

- Explains `input.ready` is an expression token, not runtime boolean.
- Replaces JavaScript control flow with graph-level `step().if` or expression helpers such as `and`, `eq`, `ifElse`.
- Mentions `workflows check` catches Expr truthiness misuse.
