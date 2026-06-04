# Runtime Reference

## Scheduler

`syncRun()` advances persisted `run.json` state. It executes deterministic program stages, collects ready agent work, runs fanout pools, runs fanin after lanes are terminal, and updates run status.

Run directories contain `workflow.spec.yaml`, `execution-plan.json`, `input.json`, `run.json`, `outputs/`, `attempts/`, `sessions/`, `events.ndjson`, and `worker.log` for background runs.

Agent session bindings live at `sessions/actor-bindings.json`.

## Program Tasks

Program task v1 supports only `operation: command`. Non-zero exit codes are data, not blockers. cwd safety, spawn failure, timeout, and output recording failures block with `PROGRAM_COMMAND_*`.

## Fanout/Fanin

Fanout first creates internal `results`, then runs required fanin. Final downstream output is fanin output. Program fanin supports `mergeArrays`; agent fanin receives `results` in the prompt context. Monitor fanin tasks stay `pending` until all fanout items and lanes are terminal.

Session keys:

- Top-level fanin: `fanin:<stageId>`
- Loop body fanin: `loop:<loopId>:round:<N>:fanin:<bodyStageId>`
- Loop body agent stage: `loop:<loopId>:round:<N>:stage:<bodyStageId>:agent:<label>`

## Recovery

Stale recovery uses attempt-scoped event activity and only triggers after stage timeout plus grace. Resume can re-aggregate terminal fanout items and run missing/blocked fanin without rerunning completed fanin.
