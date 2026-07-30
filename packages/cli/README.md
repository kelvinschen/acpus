# acpus

Command-line entry point for Acpus TypeScript workflows.

Use a quoted heredoc for a self-contained one-off Workflow, or a path for a file-backed Workflow:

```sh
acpus workflow run - <<'WORKFLOW'
import { defineWorkflow, z } from "acpus/core";
export default defineWorkflow({
  name: "one-off",
  inputSchema: z.object({}),
}).build(() => ({}));
WORKFLOW

acpus workflow check workflow.ts
acpus workflow run workflow.ts --input '{"ready":true}'
acpus workflow run workflow.ts --input '{"ready":true}' --follow
acpus workflow run workflow.ts --input '{"ready":true}' --await-decision
acpus workflow viz workflow.ts
acpus workflow viz workflow.ts --out workflow-viz.html
acpus skill install --project --agent universal,claude
```

`acpus workflow check` statically checks and prepares the workflow through
`@acpus/workflow-compiler` without admitting a run or writing durable preflight
artifacts. `acpus workflow run` delegates prepared workflows to
`@acpus/runtime`, submits by default, and reports sparse inspect/follow
guidance. Pass `--follow` to wait for terminal status, or `--await-decision`
to regain control at input, pause, or terminal boundaries. `acpus workflow viz`
prints a compact terminal tree by default; `--out` writes a self-contained
static HTML visualization instead. The `acpus runs` command group inspects and
controls durable runs. `acpus wf` is a shorter alias for `acpus workflow`.

`acpus skill install` copies the bundled Acpus skill to selected fixed targets:
`.agents/skills/acpus` for universal agents and `.claude/skills/acpus` for
Claude, rooted at either the current project or operating-system home. It
creates selected skills roots when needed. Interactive terminals prompt for
missing selections; scripts must pass `--project` or `--global` together with
`--agent universal`, `--agent claude`, or `--agent universal,claude`.
`acpus skill uninstall` removes only installed targets that can be identified
as the Acpus skill. Use `acpus skill read` to get its bundled usage guide
without installing it.
