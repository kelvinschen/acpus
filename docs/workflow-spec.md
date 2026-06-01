# Workflow Spec

`workflow.spec.json` is the stable, hand-editable authoring interface for the
dynamic ACPX orchestrator.

The canonical schema version is:

```json
{
  "schemaVersion": "acpx-workflow-orchestrator.workflow/v1",
  "root": "plan"
}
```

Main Agent writes specs directly. `skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator validate --spec`
then performs Zod shape validation and compiler lint checks.

See `workflows/examples/*.workflow.spec.json` for complete examples.

Key rules:

- exactly one root stage
- `root` must explicitly name that dependency-free root stage
- exactly one `summarize` stage
- `summarize` is terminal and only runs on the normal completion path
- explicit `dependsOn`
- no global `edges`
- no arbitrary cycles; use `fixLoop`
- route branching must be expressed by `decisionGate`
- file/glob discovery must be an explicit `discover` stage
- agent discovery requires an explicit role, prompt, and item limit
- `fanout` schedules one independent runtime item per selected item while
  respecting global and stage concurrency
- fanout items use deterministic item session keys and are aggregated by the
  orchestrator before downstream stages run
- edit fanout is allowed, but must be followed by a read-only reconcile/reduce
  stage
- prompt placeholders are `${variableName}` only
- variables must declare `source` and optional fixed built-in transforms
- input defaults and runtime `--input-json` values are checked against the
  lightweight input type declarations
- agent output should end with one plain JSON object; the parser selects the
  last balanced JSON object and tolerates non-JSON tail text

Stage output contracts are inferred from role category:

- implementation roles produce changed files and checks
- validation/review roles produce verdict, severity counts, findings, and checks
- summarize produces `finalVerdict`, deliverables, changed files, checks,
  warnings, risks, and next actions

The compiler injects a safety/output footer into every agent prompt and rejects
undeclared variables or unsafe graph shapes with JSON Pointer errors.

`limits.maxAgents` is enforced against worst-case planned agent calls, including
fanout item agents and one possible output-repair call per agent invocation.
At runtime, actual agent and repair attempts are recorded in `run.json`.
Transient agent runtime failures get one automatic retry; the retry is counted
in `agentUsage.actual`, and repair-turn retries also count in `repairCalls`.
