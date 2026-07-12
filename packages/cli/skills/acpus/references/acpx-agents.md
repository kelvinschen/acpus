# Acpx Agents

Use named acpx agents with `use` whenever acpx exposes the agent by name:

```ts
agents: {
  reviewer: { use: "codex" },
}
```

Use `command` only for a raw ACP command that acpx does not expose as a named agent:

```ts
agents: {
  reviewer: { command: "my-acp-server --stdio" },
}
```

## Built-in Agents

The upstream acpx built-ins are:

| Agent | Default command |
| --- | --- |
| `pi` | `npx pi-acp` |
| `openclaw` | `openclaw acp` |
| `codex` | `npx -y @agentclientprotocol/codex-acp` |
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` |
| `gemini` | `gemini --acp` |
| `cursor` | `cursor-agent acp` |
| `copilot` | `copilot --acp --stdio` |
| `droid` | `droid exec --output-format acp` |
| `fast-agent` | `uvx fast-agent-mcp acp` |
| `grok-build` | `grok agent stdio` |
| `iflow` | `iflow --experimental-acp` |
| `kilocode` | `npx -y @kilocode/cli acp` |
| `kimi` | `kimi acp` |
| `kiro` | `kiro-cli-chat acp` |
| `mux` | `npx -y mux@^0.27.0 acp` |
| `opencode` | `npx -y opencode-ai acp` |
| `qoder` | `qodercli --acp` |
| `qwen` | `qwen --acp` |
| `trae` | `traecli acp serve` |

`factory-droid` and `factorydroid` also resolve to `droid`.

For any built-in agent, declare `{ use: "<agent>" }`. Do not spell its default command manually in workflow source.

## Local Named Agents

Some local acpx installs expose additional named agents from `~/.acpx/config.json`, for example `traex`. These are also valid with `use`:

```ts
agents: {
  worker: { use: "traex" },
}
```

When a user asks for an agent that is not in the built-in list, inspect local acpx commands before falling back to `command`:

```sh
acpx --help | sed -n '/^Commands:/,/^$/p' | grep -E '^[[:space:]]+[[:alnum:]_-]+([[:space:]]|$)'
```

If the agent appears in that command list, or is configured under `~/.acpx/config.json` `agents`, use `{ use: "<agent>" }`. Use `{ command: "..." }` only when the agent is a raw ACP server command and acpx has no named token for it.

## Claude User Settings

Upstream `acpx claude` isolates Claude user settings by default. Setting `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` lets the spawned Claude session load user settings when those settings are needed and do not conflict with ACP-spawned sessions.
