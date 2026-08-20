# ACP Agents

Use `use` for an Acpus built-in, Host-provided, or configured named Agent:

```ts
agents: {
  reviewer: { use: "codex", config: { reasoning_effort: "high" } },
}
```

Use `command` only when the user supplies a raw ACP server command:

```ts
agents: {
  reviewer: { command: "my-acp-server --stdio" },
}
```

An explicit `command` launches as written and bypasses named Agent lookup.

## Built-in Agents

The built-ins are `pi`, `openclaw`, `codex`, `claude`, `gemini`, `cursor`,
`copilot`, `droid`, `fast-agent`, `grok-build`, `iflow`, `kilocode`, `kimi`,
`kiro`, `mux`, `opencode`, `pool`, `qoder`, `qwen`, `trae`, and `zeroclaw`.
Declare any of them as `{ use: "<agent>" }`.

## Configured Agents

- **Global:** Add commands to `$HOME/.acpus/agents.json`.
- **Project:** Add project-specific commands to `<cwd>/.acpus/agents.json`.
- **Precedence:** A project entry overrides a global entry with the same normalized name.
- **Shape:** Each file contains only `agents`; each entry is a non-empty Shell command:

```json
{
  "agents": {
    "my-agent": "my-acp-server --stdio"
  }
}
```


Then select it normally:

```ts
agents: {
  worker: { use: "my-agent" },
}
```

- **Unknown named Agent:** Add a non-empty command to configuration.
- **User supplied a raw command:** Change the definition to `{ command: "..." }`.
- **Invalid configuration:** Fix the path and entry named by the diagnostic; every present file is validated completely.
- **After an ambient configuration fix:** Retry the failed Agent or containing frame.
- **To change the workflow's Agent definition:** Fork.

- **Resolution order:** Host-provided Agent, file configuration, then built-in catalog.
- **Later work:** A shared-session occurrence, Retry generation, or Steer replacement resolves current configuration.

## ACP Agent Config

- Use top-level workflow `config` for static string ACP Session options.
- `config.model` overrides top-level `model`; other keys select ACP options.
