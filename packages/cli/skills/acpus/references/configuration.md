# Acpus Configuration

Acpus uses one closed JSON file per scope for named Agents, Agent Presets, Authoring Agent scale, and Runtime Hooks.

## Files And Shape

- Project: `<workspace>/.acpus/config.json`
- Global: `$HOME/.acpus/config.json`

The optional top-level fields are exactly `agents`, `presets`, `authoring`, and `hooks`; omission means empty. Invalid JSON, an unknown top-level field, or invalid content in any section invalidates the whole file for every consumer. Use [`config/example.json`](../config/example.json) as the complete example.

Project configuration follows the Runtime workspace, never an Agent `cwd`. Global configuration follows the Runtime/Host home, never workflow `env.HOME`.

## Named Agents

`agents` maps a normalized name to a non-empty Shell command:

```json
{
  "agents": {
    "my-agent": "my-acp-server --stdio"
  }
}
```

Named launch precedence is Host, project, global, then the built-in catalog. Project entries shadow global entries. An explicit workflow `command` bypasses named lookup. Built-in names such as `codex` and `claude` need no `agents` entry, but their Agent must be installed, authenticated, and usable.

Names normalize by trim plus lowercase; normalized collisions invalidate the file. Commands pass unchanged to the platform Shell.

Agent configuration is read again for each new Session lease. After fixing an ambient launch problem, Retry the Attempt; Fork to change a frozen admitted binding.

## Agent Presets

`presets` maps a reusable id to selection guidance and one concrete Agent definition:

```json
{
  "presets": {
    "deep-coder": {
      "guidance": "Complex implementation and debugging",
      "agent": { "use": "codex", "model": "gpt-5.6-sol" }
    }
  }
}
```

Ids match `^[a-z0-9][a-z0-9_-]{0,63}$`; `dsh` is Host-reserved. Each scope accepts at most 50 Presets. Guidance is 1–2,000 trimmed characters. `agent` contains exactly one non-empty `use` or `command` plus optional `model`, string-to-string `config`, `permissionMode`, non-empty `cwd`, and string-to-string `env` fields.

Preset precedence is Host, project, then global. Host Presets are process-local and are not written to this file. Project shadows global for the same id. Presets are re-read during discovery and admission, then expanded and frozen into the admitted Run.

List available choices:

```sh
acpus agent presets [--project | --global]
```

Add a definition without overwriting an existing id:

```sh
acpus agent presets add deep-coder --global --definition '{
  "guidance":"Complex implementation and debugging",
  "agent":{"use":"codex","model":"gpt-5.6-sol"}
}'
```

Remove one definition from an explicit scope:

```sh
acpus agent presets remove deep-coder --global
```

Use `--project` for the workspace or `--global` for the user. Add and remove require one scope. If the user describes the desired purpose, Agent, model/options, and scope in natural language, translate that request into the complete definition. Ask when scope is missing. Preset writes modify only `presets` and preserve `agents`, `authoring`, and `hooks`.

## Authoring Agent Scale

Set `authoring.agentScale` to a positive safe integer or `small`, `medium`, `large`, or `unrestricted`. The named scales suggest at most 4, 12, and 32 Agent execution occurrences; `unrestricted` has no suggested maximum. Project configuration overrides global configuration, and `ACPUS_AUTHORING_AGENT_SCALE` overrides both for the current process. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.

```sh
acpus agent
acpus agent scale [--project | --global]
acpus agent scale set medium --project
acpus agent scale unset --project
```

Scale writes preserve every other config section. Set and unset require one explicit writable scope. An environment override does not prevent a write, but continues to determine the effective context until removed. Unset is idempotent and does not create configuration when the scope is already unconfigured.

## Runtime Hooks

Hooks run configured Shell commands as non-interfering side effects when durable Runtime events are committed. Project and global Hook entries combine by direct union; every matching entry runs.

Supported events are:

- `run.started`
- `run.completed`
- `run.failed`
- `run.canceled`
- `run.awaiting`
- `node.started`
- `node.completed`
- `node.failed`

Each entry requires a non-empty `command` and may contain `id`, `timeout`, and `match`:

```json
{
  "hooks": {
    "node.failed": [
      {
        "id": "record-failed-agent",
        "match": { "kind": "^agent$" },
        "command": "cat > .acpus/last-agent-failure.json",
        "timeout": "10s"
      }
    ]
  }
}
```

`match` values are JavaScript regular expressions and combine with AND semantics. `match.workflow` applies to the frozen workflow name. `match.nodeId`, `match.nodeKey`, and `match.kind` apply to `node.*` events and `run.awaiting`. Duplicate ids remain independent entries; an omitted id receives a readable effective id.

Hook runtime behavior:

- Commands start asynchronously in the workflow workspace with no ordering guarantee; shutdown waits for active Hooks.
- Stdin receives sensitive JSON containing `event`, `eventSequence`, `run`, and optional `node`, `output`, `error`, `cancellation`, or `signal` context.
- Hooks trigger only for newly committed events, not reads or duplicate controls. Failure, timeout, and output do not change workflow state or output.
- `timeout` accepts `ms`, `s`, `m`, `h`, and `d`; omission defaults to 30 seconds. `w` is unsupported.
- Journal rows are terminal `completed`, `failed`, or `timed_out` records. `runs inspect` shows available history only for terminal Runs.
- Hooks load once at daemon startup. Configuration changes take effect after the next daemon start; invalid configuration prevents startup.

Validate or inspect both the whole unified file and its effective Hooks:

```sh
acpus hooks validate [--project | --global]
acpus hooks list [--project | --global]
```

The scope flags are mutually exclusive and the commands do not accept `--path`. For scratch global validation, point `HOME` at a directory containing `.acpus/config.json`, then run `acpus hooks validate --global`.
