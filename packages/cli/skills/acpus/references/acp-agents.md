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
`factory-droid` and `factorydroid` select `droid`. Declare any of them as
`{ use: "<agent>" }`.

## Configured Agents

Add other named Agents as structured argv in the effective home directory's
`.acpus/agents.json` when a home is available, or in
`<cwd>/.acpus/agents.json` when the launch belongs to one project. A project
entry overrides a global entry with the same normalized name. Each file
contains only the `agents` map and each entry contains only `argv`:

```json
{
  "agents": {
    "my-agent": {
      "argv": ["my-acp-server", "--stdio"]
    }
  }
}
```

Then select it normally:

```ts
agents: {
  worker: { use: "my-agent" },
}
```

If Acpus reports an unknown named Agent, either add its non-empty argv to one
of those files or, for a raw command already supplied by the user, change the
definition to `{ command: "..." }`. Every present configuration file is
validated completely, so fix the path and entry named by the diagnostic. Retry
a pre-execution configuration failure through its containing frame or whole
run after fixing ambient configuration; fork when changing the workflow's
Agent definition.

Host applications may register immutable named Agent launches. Those take
precedence over file configuration; file configuration takes precedence over
the built-in catalog. Acpus resolves a name once per managed attempt, so turns
inside that attempt retain one launch while a later attempt observes changes.

## ACP Agent Config

Use top-level workflow `config` for a static string map of desired ACP session
options. `config.model` selects the model and overrides the top-level `model`;
other keys are applied as ACP configuration options. Do not put secrets in
workflow `config` or authored `env`, because Runtime records them for
Forensics. Use ambient Agent/provider credential mechanisms instead.
