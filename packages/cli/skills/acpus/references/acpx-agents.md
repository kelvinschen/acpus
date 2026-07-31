# Acpx Agents

Use named acpx agents with `use` whenever acpx exposes the agent by name:

```ts
agents: {
  reviewer: { use: "codex", config: { mode: "full-access", reasoning_effort: "high" } },
}
```

Use `command` only for a raw ACP command that acpx does not expose as a named agent:

```ts
agents: {
  reviewer: { command: "my-acp-server --stdio" },
}
```

## Built-in Agents

The upstream acpx built-ins are `pi`, `openclaw`, `codex`, `claude`, `gemini`, `cursor`, `copilot`, `droid`, `fast-agent`, `grok-build`, `iflow`, `kilocode`, `kimi`, `kiro`, `mux`, `opencode`, `qoder`, `qwen`, and `trae`.

`factory-droid` and `factorydroid` also resolve to `droid`.

**For any built-in agent, declare `{ use: "<agent>" }`.** Only when the user explicitly needs to override a built-in ACP command or arguments, or the adapter is outdated, configure acpx according to [acpx agents](https://github.com/openclaw/acpx/blob/main/docs/agents.md).

## Local Named Agents

Some local acpx installs expose additional named agents from `~/.acpx/config.json`, for example `my-agent`. These are also valid with `use`:

```ts
agents: {
  worker: { use: "my-agent" },
}
```

When a user asks for an agent that is not in the built-in list, inspect local acpx commands before falling back to `command`:

```sh
acpx --help | sed -n '/^Commands:/,/^$/p' | grep -E '^[[:space:]]+[[:alnum:]_-]+([[:space:]]|$)'
```

If the agent appears in that command list, or is configured under `~/.acpx/config.json` `agents`, use `{ use: "<agent>" }`. Use `{ command: "..." }` only when the agent is a raw ACP server command and acpx has no named token for it.

## ACP Agent Config 
Use top-level `config` for a static string map: `config.model` selects the model, and every other key is applied to the persistent ACP session.
Verified keys: Codex `model`, `reasoning_effort`; Claude `model`, `effort`; Trae `model`, `reasoning_effort`.

## Claude User Settings

Acpus sets `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` for `claude`, so user settings load by default. Set `0` to retain upstream isolation when user explicitly asked.
