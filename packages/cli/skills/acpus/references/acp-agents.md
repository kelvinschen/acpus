# ACP Agents

## Select And Bind Agents

Resolve each unbound Agent slot in this order:

1. Honor an explicit user choice. A Preset id, named Agent, or raw command becomes exactly `{ "preset": "id" }`, `{ "use": "name" }`, or `{ "command": "..." }`. Use it without discovery or reconfirmation, and do not reinterpret one kind as another.
2. Otherwise select the available Preset whose `guidance` best matches the slot's work.
3. If discovery returns no Presets, stop before admission and tell the user automatic selection needs a configured Preset. Ask them for its purpose, Agent, optional model/options, and scope, then follow [Configuration](configuration.md). If scope is missing, ask.

When no Preset exists, also offer direct built-in choices such as `codex` or `claude`. They need no `agents` configuration, but the user must choose one and confirm that the corresponding Agent is installed, authenticated, and usable. Do not choose one silently.

Reusable workflows declare unbound Agent slots:

```ts
agents: {
  worker: {},
  reviewer: {},
}
```

Inject chosen ids by slot name:

```sh
acpus workflow run workflow.ts --agents '{
  "worker":{"preset":"deep-coder"},
  "reviewer":{"preset":"critical-reviewer"}
}'
```

Runtime expands and freezes ids. Direct fields bind one invocation:

```json
{ "worker": { "use": "codex", "config": { "reasoning_effort": "high" } } }
```

Every slot must bind before admission. One injection sets either `preset` or direct Agent fields, never both.

## Concrete Agents

A workflow may bind `use`, or `command` for a user-supplied raw ACP server:

```ts
agents: {
  reviewer: { use: "codex" },
  private: { command: "my-acp-server --stdio" },
}
```

An explicit `command` launches as written and bypasses named Agent lookup.

Built-ins are `pi`, `openclaw`, `codex`, `claude`, `gemini`, `cursor`, `copilot`, `droid`, `fast-agent`, `grok-build`, `iflow`, `kilocode`, `kimi`, `kiro`, `mux`, `opencode`, `pool`, `qoder`, `qwen`, `trae`, and `zeroclaw`.
