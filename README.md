# ACPX Agent Orchestrator

Runtime-driven workflow orchestration for ACP agents.

The Main Agent creates a structured workflow spec. `skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator`
validates, previews, compiles it to `execution-plan.json`, and runs a
step-driven scheduler that talks directly to `acpx/runtime` with run-local
persistent sessions.

Core commands:

```bash
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator validate --spec workflows/examples/simple-feature.workflow.spec.json
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator preview --spec workflows/examples/simple-feature.workflow.spec.json
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --spec workflows/examples/simple-feature.workflow.spec.json --yes
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator follow <logical-run-id>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator diagnose <logical-run-id> --wait
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <logical-run-id>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <logical-run-id> --html --output report.html
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report serve --run <logical-run-id> --port 0
```

Run directories contain `workflow.spec.json`, `execution-plan.json`, `input.json`,
final `outputs/`, raw `attempts/`, run-local `acpx-state/`, `sessions/`, and
`events.ndjson`. The orchestrator does not generate or execute ACPX flow files.

Docs:

- [docs/workflow-spec.md](docs/workflow-spec.md)
- [docs/cli.md](docs/cli.md)
- [docs/html-report-design.md](docs/html-report-design.md)
- [docs/error-codes.md](docs/error-codes.md)
- [docs/runtime-orchestrator-refactor-implementation.md](docs/runtime-orchestrator-refactor-implementation.md)
