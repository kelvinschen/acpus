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

Acpus resolves additional named Agents from `~/.acpx/config.json` and the
effective working directory's `.acpxrc.json`, for example `my-agent`. These are
valid with `use`:

```ts
agents: {
  worker: { use: "my-agent" },
}
```

When a user asks for an agent that is not in the built-in list, inspect local acpx commands before falling back to `command`:

```sh
acpx --help | sed -n '/^Commands:/,/^$/p' | grep -E '^[[:space:]]+[[:alnum:]_-]+([[:space:]]|$)'
```

If the Agent appears in that command list, or is configured in either Acpx
`agents` map, use `{ use: "<agent>" }`. Acpus resolves that command once per
managed attempt, so repair and steering turns keep the same command while a
later attempt observes config changes. Use `{ command: "..." }` only when the
Agent is a raw ACP server command and Acpx has no named token for it; explicit
commands bypass Acpx config validation.

Acpus reuses only Acpx named Agent commands. It does not apply Acpx
`mcpServers`, `auth`, permission defaults, `defaultAgent`, TTL, timeout, or
format. Agent login state, provider environment variables, and `ACPX_AUTH_*`
variables remain available through the inherited Agent environment. Because
Acpx validates its complete config before exposing the resolved `agents` map,
an invalid value in another Acpx config field can still block named resolution.

## ACP Agent Config 
Use top-level `config` for a static string map: `config.model` selects the model, and every other key is applied to the persistent ACP session.
Verified keys: Codex `model`, `reasoning_effort`; Claude `model`, `effort`; Trae `model`, `reasoning_effort`.

## Claude User Settings

Acpus sets `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` for `claude`, so user settings load by default. Set `0` to retain upstream isolation when user explicitly asked.
