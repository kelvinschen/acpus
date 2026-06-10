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
