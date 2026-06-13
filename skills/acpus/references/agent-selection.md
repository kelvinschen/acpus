# Agent Selection

Acpus runs Agent Steps through acpx. The `agents` section names worker agents for the workflow.

## If The User Names Agents

Use the named agents exactly when they are acpx-supported:

```yaml
agents:
  planner:
    use: claude
  implementer:
    use: codex
```

For custom ACP servers, use `type: command`:

```yaml
agents:
  local_worker:
    type: command
    use: "my-acp-server --project ."
```

## If The User Does Not Name Agents

Ask which agents to use. Do not silently assume.

Good question: "Which acpx-supported worker agents should this workflow use for planning, implementation, and review?"

## If The User Says To Choose Freely

1. Inspect available acpx builtins:

   ```sh
   acpx --help
   ```

2. Prefer agents that match the task shape:

   - Planning/research/review: `claude`, `pi`, `gemini`, `qwen`.
   - Code implementation/repair: `codex`, `cursor`, `trae`, `opencode`, `kiro`.
   - Local or custom ACP server: `type: command` with acpx `--agent` support.

3. If a selected agent requires auth or is not configured, stop and ask the user rather than silently falling back.

4. Keep roles explicit in the Workflow Spec: `planner`, `researcher`, `implementer`, `reviewer`, `judge`, `fixer`.

## Temporary Agent Overrides

Use Agent Overrides when the user wants to reuse an existing Workflow Spec but temporarily run one submission with different agents. This is most common before starting a new Run:

```sh
acpus workflows run <workflow-or-ref> --dry-run --agents '{"reviewer":{"type":"builtin","use":"claude","model":"opus"}}'
acpus workflows run <workflow-or-ref> --background --agents '{"reviewer":{"type":"builtin","use":"claude","model":"opus"}}' --input '<json>'
```

Prefer inline JSON for `--agents`. Do not generate inline YAML in automated instructions; shell quoting and commas are easier to get wrong. For larger maps, write or reference a JSON file:

```json
{
  "reviewer": {
    "type": "builtin",
    "use": "pi",
    "model": "aiden-anthropic/deepseek-v4-pro"
  },
  "cross_examiner": {
    "type": "builtin",
    "use": "traex"
  }
}
```

```sh
acpus workflows run <workflow-or-ref> --agents agents.json --input '<json>'
```

Rules:

- `type` and `use` must be supplied together when changing agent identity.
- `model`, `cwd`, and `env` may be overridden without changing identity.
- `env` merges by key.
- v1 does not support deleting fields or env keys.
- Agent Overrides are applied before compilation and frozen into the new Run; they do not edit the Workflow Spec YAML or affect an already-started Run.

Forked Runs inherit the source Run's effective Agent Overrides by default. Use current `--agents` to override only what should change for the Forked Run:

```sh
acpus runs fork <runId> <fixed-spec> --from workflow/cross_examine --agents '{"cross_examiner":{"type":"builtin","use":"claude"}}'
```

Dry-run fork when inheritance or agent choice matters:

```sh
acpus runs fork <runId> <fixed-spec> --dry-run --json --agents '{"cross_examiner":{"type":"builtin","use":"claude"}}'
```
