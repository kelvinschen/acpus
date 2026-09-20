# Configure MCP

Configure the client's local stdio server; its configuration format belongs to
that client. A typical entry is:

```json
{"mcpServers":{"acpus":{"command":"acpus","args":["mcp"]}}}
```

For isolated ACPUS configuration and state, add
`"env":{"ACPUS_HOME":"/absolute/acpus-data"}` to the server entry. Otherwise CLI
and MCP share `~/.acpus`. Home is the data directory itself, not the OS user home.
Agent backends still need their own installation and authentication.

Restart/connect the server and verify its tools are discovered. No Skill
installation or project-specific server configuration is required; the server
supplies usage guidance and accepts Workspace per tool call.
