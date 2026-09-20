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

## Compose an MCP server

Install `acpus` and `@modelcontextprotocol/server`, then compose:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { acpusInstructions, registerAcpusTools } from "acpus/mcp";

const server = new McpServer({ name: "my-agent", version: "1.0.0" }, {
  instructions: `${acpusInstructions}\nUse our project conventions.`,
});
const tools = registerAcpusTools(server, {
  wrapTool: (name, call) => async (args, context) => {
    const result = await call(args, context);
    console.error(name, result.structuredContent);
    return result;
  },
});
tools.acpus_run.update({ title: "Run workflow" });
```

Choose your transport. Wrappers receive validated arguments and SDK context;
cancellation preserves admitted Runs. Registration captures `ACPUS_HOME`.
Instructions are replaceable. For UI, associate successful `workspace` / `runId`
results with trusted host sessions, then observe separately. The host owns
observers and shutdown; await pending calls after closing.
