# ACPUS through MCP

ACPUS compiles typed TypeScript Workflows into durable Runs. Own the loop: author,
run, observe, recover when necessary, and verify the user's goal.

## Author

Read `references/authoring.md` through `acpus_guide({path})` for graph and expression
rules, Agent selection, and bindings. Call
`acpus_agent({workspace})` for effective scale and Preset choices. Select Presets
by guidance. Read `references/advanced-authoring.md` or
`references/signal-authoring.md` when their topics apply. Relative document links
resolve from that document's directory; examples under `workflows/examples` are
readable through the same tool. The returned topics list available paths.

Every project tool requires an absolute `workspace` on the server filesystem.
Use the user's task project, retaining the canonical path returned by tools.
Source locations do not change the execution workspace.

Call `acpus_run` with inline TypeScript:

```json
{"workspace":"/projects/app","source":"<TypeScript module>","input":{},"agents":{"worker":"chosen-preset"}}
```

Or use `"file":"workflow.ts"` instead of `source` for an existing file, resolved
relative to Workspace. Supply exactly one. Use a file for local module imports.

`input` and `agents` are JSON values, not encoded JSON strings or filenames.
Run defaults omitted input to `{}`, validates, and returns after durable
admission. Correct validation errors and resubmit. Set `dryRun: true` only when
validation without execution is wanted: it checks source and supplied input and
bindings, reports unbound Agent slots, and creates no Run. Preparation still
executes module code.

## Observe and control

Use the returned `{workspace, runId}` for all follow-up calls:

- `acpus_list_runs`: find Runs; optionally filter by exact `name`, then paginate with
  `nextOffset` as `offset`.
- `acpus_inspect`: read Summary once, then narrow to the target controlling the
  next decision. Copy candidate `@ref` selectors for repeated occurrences.
  `wait: "decision"` waits for input, pause, or terminal state; `wait: "terminal"`
  waits for completion. `timeoutMs` is at most 30000. When `timedOut` is true,
  continue bounded waiting if the goal still needs it; timeout, silence, elapsed
  time, and metrics alone do not justify intervention. Target `detail: "timeline"`
  shows activity; `"forensics"` deepens diagnosis and cannot wait.
- `acpus_control`: use `action` with `type` pause, resume, cancel, retry, steer,
  signal, or fork. Inspect before intervening. Retry/steer require `target`;
  steer also requires `instruction`; signal requires `target` and JSON `payload`.
  Fork inherits the workflow unless `source` or `file` is supplied in `action`,
  inherits omitted input and bindings, and returns the child's identity in the
  same workspace. A control receipt confirms the applied action, not subsequent
  completion. Ask before destructive actions unless already requested.
- `acpus_artifact`: `action: {"type":"list"}` lists registered outputs, optionally
  by target; `{"type":"read","id":"..."}` reads one. Text is bounded with a
  `truncated` flag; binary results provide verified local paths and metadata.

Terminal Summary contains accepted output. Verify it against the user's goal.
Disconnect or canceled observation leaves Runs durable. Errors retain known
Workspace/Run identity and a `next` action. If mutation outcome is unknown,
inspect or list Runs before repeating it. Environment/configuration repair may
require the user to run the suggested CLI command with this server's ACPUS Home.
