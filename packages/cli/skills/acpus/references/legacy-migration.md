# Legacy-to-Next Migration Notes

The archived legacy implementation used YAML Workflow Specs interpreted at runtime. The next implementation uses TypeScript modules compiled to frozen `WorkflowIR` before runtime admission.

## Concept mapping

| Legacy | Next |
| --- | --- |
| YAML Workflow Spec | TypeScript workflow module exporting `defineWorkflow(...).build(...)` default export |
| `run: program` Program Step | Task node: `step("id").task({ run: { input, exec } })` |
| `run: agent` Agent Step | Agent node: `step("id").agent({ run: { agent: agents.name, prompt }, outputSchema? })` |
| `run: signal` Signal Node | Signal node: `step("id").signal({ run: { prompt }, outputSchema? })` |
| CEL `when` / `until` expressions | `acpus/expression` helpers such as `eq`, `and`, `where`, `coalesce`, `template`, `md` |
| `${{ ... }}` interpolation | `template\`...${expr}...\`` or `md\`...${expr}...\`` |
| YAML `pipeline`, `guard`, `loop`, `fanout`, `parallel`, `switch` | TypeScript `step().if`, `switch`, `parallel`, `fanout`, `loop`, plus `assert` |
| `workflows lint` | `workflows check` |
| `runs show` | `runs inspect` |
| `hooks.yaml` | `.acpus/hooks.json` and `$HOME/.acpus/hooks.json` |
| Legacy fork/replay/resume semantics | Next daemon controls: `pause`, `resume`, `retry`, `cancel`, `fork`, `signal` |

## Migration strategy

1. Convert YAML workflow inputs to `inputSchema` using `z` from `acpus/core`.
2. Convert each YAML node to `step("id").<kind>(...)` inside `build`.
3. Move deterministic shell/program glue into Task nodes.
4. Move agent prompts into Agent nodes using `template` or `md`.
5. Replace CEL/native expression strings with typed helpers from `acpus/expression`.
6. Replace large inline outputs with task artifacts.
7. Run `acpus workflows check <workflow.ts>` and fix check/compile/validate phases before any real run.

## Migration traps

- Do not put task output schema at the task callsite. Task output is inferred from `exec`.
- Do not capture module-scope variables in inline task `exec`; pass everything through `run.input` or use a reusable task.
- Do not use JavaScript `if`, `&&`, `||`, `===`, or native comparisons over `Expr` tokens.
- Do not assume a static node id uniquely targets a dynamic fanout/loop instance; use dynamic `nodeKey` when needed.
- Do not migrate hook config as YAML or with a top-level `hooks` wrapper.
