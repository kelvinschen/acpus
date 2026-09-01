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
npx skills add kelvinschen/acpus
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

The standard Skills tool installs the unversioned Acpus router Skill from the
repository. The router runs `acpus skill read` once per task to load the
complete Skill bundled with the current CLI version together with the current
workspace's Agent authoring context. Updating the CLI updates that complete
guide without reinstalling the router. `acpus skill read` can also be used
directly without installing the router Skill.
