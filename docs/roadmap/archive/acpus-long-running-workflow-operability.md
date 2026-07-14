# Acpus Long-running Workflow Operability Roadmap

Status: completed and archived on 2026-07-14.

## Context

This roadmap records Acpus product gaps observed while authoring, running, and
recovering the long-running `skill-evolution` workflow on 2026-07-14. The
initial run failed in a subject Agent. After the workflow was fixed, a separate
new run completed after about one hour with dynamic fanout, retries, 23
scheduled Agent calls, and operator inspection throughout the run. Attempts to
use replacement fork supplied source-run targets where replacement-workflow
targets were expected; the completed run was not a fork.

The run confirmed that durable failure state, targeted retry, background
execution, and artifact registration are useful. It also exposed gaps that
apply to long-running workflows generally rather than to Skill Evolution's
benchmark or scoring logic. This record describes those product-level gaps;
current behavior remains owned by the [Runtime](../../specs/runtime-spec.md),
[Agent Executor](../../specs/agent-executor-spec.md), and
[CLI](../../specs/cli-spec.md) specs.

## Decisions

| ID | Topic | Disposition |
| --- | --- | --- |
| ACPUS-1 | Agent/provider preflight | Deferred; no optimization planned now |
| ACPUS-2 | Incomplete Agent telemetry | Optimize |
| ACPUS-5 | Live reusable Task reproducibility | Accepted design tradeoff; no action |
| ACPUS-6 | Long-running `inspect --follow` experience | Narrow CLI transcript and documentation optimization |
| ACPUS-7 | Ambiguous static-node inspection status | Fix static aggregate projection |
| ACPUS-8a | Direct fork lineage visibility | Add minimal inspect projection |
| ACPUS-8b | Compact inspect run telemetry summary | Add a read-only aggregate projection |
| DOC-1 | Replacement fork recovery guidance | Documentation optimization only |

## Gaps

### ACPUS-1: Agent/provider preflight

**Context:** `workflow check` validates the workflow and Agent configuration
shape without making a provider request. Provider authentication and model
availability can only be proven by making a real request.

**Observed behavior:** the workflow passed checking with no diagnostics, while
the first Pi subject call later failed with `AUTH_REQUIRED`. A preflight request
would itself consume provider capacity and may incur cost.

**Brief direction:** defer this item. Do not add request-backed preflight solely
to detect authentication or model availability. Revisit only if ACP or a
provider exposes a reliable cost-free capability check.

### ACPUS-2: Incomplete Agent telemetry

**Context:** Acpus normalizes telemetry delivered through ACP, but some Agents
do not implement every optional telemetry field completely.

**Observed behavior:** completed Pi turns had no usable token total. Downstream
reporting represented the missing measurement as `0`, which is
indistinguishable from a real zero and makes cost or efficiency conclusions
misleading.

**Brief direction:** preserve missing telemetry as explicitly `unavailable`
through canonical turn data and operator projections. Consumers should be able
to distinguish unavailable, partial, and measured values without Acpus
inventing estimates.

### ACPUS-5: Live reusable Task reproducibility

**Context:** frozen workflow IR identifies reusable Tasks, while the reusable
Task module is loaded live for each attempt. A retry may therefore deliberately
execute updated Task code.

**Observed behavior:** editing a reusable Task allowed the same run to recover
without another replacement fork, while its later attempt no longer used the
exact implementation present at admission.

**Brief direction:** no product change. This is an intentional design tradeoff;
users own consistency of live Task modules. A changed module is treated as a
deliberate operator action, not an Acpus reproducibility defect.

### ACPUS-6: Long-running `inspect --follow` experience

**Context:** runtime follow already emits a compact initial snapshot, semantic
sparse updates, bounded Agent progress, and terminal output once. The CLI
appends bounded semantic changes for non-TTY streams and uses ANSI to redraw
only the live region for a TTY.

**Observed behavior:** following through an Agent tool with a PTY captured ANSI
redraws as repeated transcript text even though a human terminal would replace
the same live region. Non-TTY overview correctly limited ordinary dynamic
contexts, but emitted a new `contexts omitted` summary for each update batch
after the unique-context budget was exhausted.

**Brief direction:** keep the existing runtime stream and TTY presentation.
Coalesce or rate-limit non-TTY omission summaries while continuing to emit
actionable failures immediately. Document that Agents following long runs
should use a non-TTY stream or filtered NDJSON rather than allocating a PTY.
Business phase names, trial totals, and workflow-specific Agent-call budgets are
not inferred by Acpus.

### ACPUS-7: Ambiguous static-node inspection status

**Context:** Runtime target inspection defines a static-node target as an
aggregate, while an exact dynamic `nodeKey`, `frameKey`, or attempt target
represents one execution context.

**Observed behavior:** the static target summary selected one instance by
timestamp, and the CLI could then select the first same-node item instead. A
static target with one completed and one running instance therefore displayed
`completed` and the old instance's output. A focused regression probe expected
the aggregate `running` status and received `completed`.

**Brief direction:** for multiple matching instances, report aggregate status
and status counts without attaching an arbitrary instance's node key, output,
failure, prompt, attempt, or Agent progress. Preserve the current detailed view
when exactly one instance matches. Direct operators to an exact dynamic target
for instance-specific details.

### ACPUS-8a: Direct fork lineage visibility

**Context:** fork admission already persists a `run.forked` event containing
the direct `sourceRunId` and requested target or unsafe-reuse options. The fork
control receipt shows source and child once, but later inspection omits that
relationship.

**Observed behavior:** after reconnecting to the study, ordinary and raw
inspection did not distinguish the independently started replacement run from
a child fork. Establishing that it was not a fork required correlating event
absence and the repeated designer attempt.

**Brief direction:** project only the direct source run and this fork's target
or unsafe-reuse options in overview, target, and JSON inspection. Do not add
recursive ancestry, reverse child lookup, a lineage graph, or a new persistence
model.

### ACPUS-8b: Compact inspect run telemetry summary

**Context:** Acpus already persists normalized Agent turn/progress telemetry,
and individual Agent inspection exposes turns, tool calls, context, and token
usage when the ACP implementation provides them. The missing capability is a
bounded run-level projection in compact inspection, not a separate usage
consumer, artifact, or accounting subsystem.

**Observed behavior:** repeated or folded Agent nodes expose their own compact
telemetry, but the default run inspection has no top-level summary. An operator
therefore has to expand or externally aggregate many dynamic Agent instances to
understand overall Agent activity. Workflow-specific call budgets were
incorrectly mixed with runtime telemetry in the original observation.

**Brief direction:** derive one read-only summary line in run compact inspection
from existing durable telemetry: `instances=<n> attempts=<n> turns=<n>`.
`instances` counts materialized Agent node instances, `attempts` counts their
scheduler attempts, and `turns` counts provider turns including response-repair
turns. Do not show tool calls, outcomes, context, tokens, prices, or
workflow-specific budgets in this run-level summary, and do not add a new
persistence model.

### DOC-1: Replacement fork recovery guidance

**Context:** targeted replacement fork already models its target as a recovery
point in the replacement workflow and uses omitted target as root completion.
It can seed compatible scheduler-accepted prerequisites without mapping a
source failure identity into the replacement graph.

**Observed behavior:** the source run's inspect target was copied into
replacement-fork commands as though it identified the same logical target in
the replacement workflow. After those commands failed, a new workflow run was
started and reusable designer work was repeated. This was an operator and
documentation error, not evidence of a missing cross-version recovery model.

**Brief direction:** improve recovery documentation only; do not add a recovery
locator, source-to-replacement mapping, new DSL, or fork/runtime behavior.

Documentation points to add or sharpen:

- Contrast retry targets, which identify executions in the frozen source run,
  with replacement-fork targets, which identify recovery points in the
  replacement workflow.
- Recommend `runs fork <source> --workflow <fixed>` without `--target` as the
  default after a workflow-source fix. Explain root completion and compatible
  prerequisite seeding in plain language.
- Explain that unchanged input and Agent overrides are inherited. Repeating the
  same values through `--input` or `--agents` is unnecessary; an explicit input
  override disables normal safe output reuse even when its JSON happens to be
  equal.
- State that a source `nodeKey` or `frameKey` from `runs inspect` is not
  automatically a replacement target. Avoid presenting source inspect commands
  as copyable replacement-fork commands.
- Explain when an explicit static replacement target is unambiguous and why a
  target under fanout or loop may require a replacement dynamic identity.
- Show the difference between retrying the frozen plan, forking with a fixed
  workflow, and starting an unrelated new run.
- Add compact examples for a node implementation fix, an Agent configuration
  change, an intentional input change, and a dynamic fanout/loop workflow.
- Explain when `--unsafe-reuse` changes compatibility checks and why it is not a
  remedy for an incorrectly selected target.
- Include common failure messages such as `not materialized in the replacement
  workflow` and `resolved to 0 dynamic replacement instances`, with the first
  safe next action for each.
