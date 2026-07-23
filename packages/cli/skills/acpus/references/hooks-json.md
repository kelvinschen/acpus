# Runtime Hooks JSON

Runtime hooks run configured shell commands as side effects when durable runtime events are committed. Hooks observe progress and write hook history; they must not change workflow state or outputs.

## Locations

- Project: `.acpus/hooks.json`
- Global: `$HOME/.acpus/hooks.json`

Project and global hook entries are merged by direct union. Both run when both match.

Use [`hooks/examples.json`](../hooks/examples.json) as the bundled example.

## Shape

A hooks file is an event map. Do not wrap it in a top-level `hooks` field.

```json
{
  "run.completed": [
    {
      "id": "record-completion",
      "command": "mkdir -p .acpus/.local/hook-samples && cat > .acpus/.local/hook-samples/last-run-completed.json",
      "timeout": "10s"
    }
  ],
  "node.failed": [
    {
      "id": "record-failed-agent",
      "match": { "kind": "agent" },
      "command": "mkdir -p .acpus/.local/hook-samples && cat > .acpus/.local/hook-samples/last-agent-failure.json"
    }
  ]
}
```

Supported events:

- `run.started`
- `run.completed`
- `run.failed`
- `run.canceled`
- `run.awaiting`
- `node.started`
- `node.completed`
- `node.failed`

Each hook entry must contain a non-empty `command`. It may contain `id`, `timeout`, and `match`.

## Matching

`match` fields are JavaScript regular expression strings. Multiple match fields combine with AND semantics.

- `match.workflow` matches the frozen workflow name.
- `match.nodeId`, `match.nodeKey`, and `match.kind` apply to `node.*` events and `run.awaiting`.
- Exact matches should be anchored when precision matters, for example `{ "kind": "^agent$" }`.

`id` is display and journal metadata only. Duplicate ids do not override or suppress entries.

## Runtime behavior

- Hook config is loaded once at daemon startup. Editing or validating files does not activate changes; they take effect on the next daemon start.
- Hook commands start asynchronously with no ordering guarantee. Terminal run state may be visible before its hook journal entry; shutdown waits for active hooks.
- Commands receive JSON on stdin with `event`, `eventSequence`, `run`, and optional `node`, `output`, `error`, `cancellation`, or `signal`. `run` includes id, workflow name/path, workspace, and status; `node` includes id/key/kind/status plus event-specific result/input/prompt. Agent prompts, Task inputs, and outputs may be sensitive.
- Hooks trigger only for newly committed `run_events` rows, not from inspect commands, projection rebuilds, read APIs, or idempotent duplicate controls that commit no new row.
- Hook failure, timeout, output, or journal failure must not change workflow status, output, IR, runtime scope, or public run event payloads.
- Invalid hook configuration fails daemon startup with an invalid hooks config error instead of silently disabling hooks.
- Hook `timeout` uses the shared duration units `ms`, `s`, `m`, `h`, and `d`; `w` is not supported. The default is 30 seconds.
- Hook journal rows are terminal only: `completed`, `failed`, or `timed_out`.
- `runs inspect` shows available hook history only for terminal runs and omits the `Hooks:` section when no history exists.

## CLI

```sh
acpus hooks validate
acpus hooks validate --project
acpus hooks validate --global
acpus hooks list
acpus hooks list --project
acpus hooks list --global
```

Reject simultaneous `--project` and `--global`.

The CLI validates only the project and global hook locations; it does not accept an arbitrary `--path`. For scratch validation without touching project hooks, set `HOME` to a scratch directory containing `.acpus/hooks.json` and run `acpus hooks validate --global`.
