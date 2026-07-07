# acpus

Command-line entry point for Acpus TypeScript workflows.

Primary workflow entry points:

```sh
acpus workflows check workflow.ts
acpus workflows run workflow.ts --input '{"ready":true}'
acpus workflows viz workflow.ts --out workflow-viz.html
acpus skill install
```

`acpus workflows check` statically checks and prepares the workflow through
`@acpus/workflow-compiler` without admitting a run or writing durable preflight
artifacts. `acpus workflows run` delegates prepared workflows to
`@acpus/runtime` and reports the admitted run. `acpus workflows viz` writes a
self-contained static workflow visualization HTML file. The `acpus runs`
command group inspects and controls durable runs. `acpus wf` is a shorter alias
for `acpus workflows`.

`acpus skill install` copies the Acpus agent skill bundled in the local `acpus`
npm package into existing project skills roots (`.agents/skills` and
`.claude/skills`) as `acpus`. Use `--global` to target `$CODEX_HOME/skills`
or `~/.codex/skills`, and `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`.
`acpus skill uninstall` removes only installed targets that can be identified
as the Acpus skill.
