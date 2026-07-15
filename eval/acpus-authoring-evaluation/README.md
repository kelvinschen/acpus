# Acpus Authoring Evaluation

This evaluation asks `pi`, `claude`, and the local named `traex` Agent to author
Acpus workflows from ten implementation-neutral product requests. The harness
lives outside the bundled skill so its protocol and requirements are not copied
into the subject workspaces.

The fixed design is 10 requirements × 3 Agents × 3 trials: 90 independent
sessions. Each session has one authoring turn and a separate retrospective turn
with the same `sessionKey`, for 180 Agent node executions. Authoring may run
`acpus workflow check` but never the authored workflow. Retrospectives are
qualitative evidence, not the source of check metrics.

Each fresh workspace contains only `AGENTS.md`, `CLAUDE.md`,
`.agents/skills/acpus`, and `.claude/skills/acpus`. Both instruction files route
Pi and TraeX exclusively to `.agents`, and Claude exclusively to `.claude`. The
preparation Task records and compares source and copy digests and fails before
authoring if they differ.

`workspaceRoot` must be an absolute path physically outside both the workflow
workspace and the skill source. The preparation Task resolves existing symlinks
and rejects either ancestor/descendant overlap so Agents cannot inherit this
repository's instructions or project skills. The sample uses `/tmp`.

## Validate Without Running

```sh
pnpm exec acpus workflow check eval/acpus-authoring-evaluation/workflow.ts \
  --input eval/acpus-authoring-evaluation/input.example.json
pnpm exec vitest run --config eval/acpus-authoring-evaluation/vitest.config.mjs
```

These eval-local tests are intentionally excluded from the repository-wide
`pnpm test` suite. Run them when changing this harness or before an evaluation.

Do not run the evaluation unless a benchmark rerun was explicitly requested.
Before an authorized run, ensure `traex` is configured and select a new
workspace root; existing trial directories are never overwritten.

## Measure An Authorized Run

```sh
node eval/acpus-authoring-evaluation/scripts/analyze-traces.mjs <run-id>
```

The analyzer invokes `acpus runs artifacts <run-id> --json` (preferring the
workspace binary) and writes `results/<run-id>/trace-metrics.json` and
`trace-metrics.md`. Use `--artifacts-json <file>` for an offline listing.

Only authoring Agent `.trace.jsonl` artifacts and their `type: "tool"` events
are read. Tool fragments are grouped by `toolCallId`; the final shell command is
split into executable segments, and only a segment beginning
`acpus workflow check` counts. Search commands and prose are excluded. A tool
call with multiple checks or a check without an explicit exit code or terminal
`completed`/`failed` status invalidates the benchmark. Diagnostic codes come
from the final tool output.

The workflow itself writes `authoring-evaluation.json` and
`authoring-pitfalls.md`, retaining completion reports and retrospectives for
audit. Formal counts always come from `trace-metrics.*`.
