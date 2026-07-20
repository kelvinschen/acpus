# acpus

Command-line entry point for Acpus TypeScript workflows.

Primary workflow entry points:

```sh
acpus workflow check workflow.ts
acpus workflow run workflow.ts --input '{"ready":true}'
acpus workflow viz workflow.ts
acpus workflow viz workflow.ts --out workflow-viz.html
acpus skill install
```

`acpus workflow check` statically checks and prepares the workflow through
`@acpus/workflow-compiler` without admitting a run or writing durable preflight
artifacts. `acpus workflow run` delegates prepared workflows to
`@acpus/runtime` and reports the admitted run. `acpus workflow viz` prints a
compact terminal tree by default; `--out` writes a self-contained static HTML
visualization instead. The `acpus runs` command group inspects and controls
durable runs. `acpus wf` is a shorter alias
for `acpus workflow`.

`acpus skill install` copies the Acpus agent skill bundled in the local `acpus`
npm package into existing project skills roots (`.agents/skills` and
`.claude/skills`) as `acpus`. Use `--global` to target `$CODEX_HOME/skills`
or `~/.codex/skills`, and `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`.
Use `--dir <skills-root>` to install into another existing root as
`<skills-root>/acpus`.
`acpus skill uninstall` removes only installed targets that can be identified
as the Acpus skill.
