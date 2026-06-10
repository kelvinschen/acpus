# Error Recovery

Start with the persisted Run state. Do not guess from terminal output alone.

```sh
acpus runs show <runId> --json
```

Find the failed or awaiting node, its `nodeKey`, error, output, rendered prompt, and artifact references. The JSON can be large; use it to locate the relevant node and artifact refs, then read the artifact files directly.

## Artifact Paths

Artifact refs are local URI pointers:

```text
artifact://runs/<runId>/nodes/<nodeKey>/<filename>
```

They resolve under the workspace state directory:

```text
.acpus/state/runs/<runId>/artifacts/<encoded-node-key>/<filename>
```

`<encoded-node-key>` is the node key with `/` replaced by `:`. For example, `workflow/review/branch:0` maps to `workflow:review:branch:0`.

## Lint Or Dry-Run Failure

- Fix the Workflow Spec before starting a Run.
- Check expression form: raw CEL for `when`/`until`/expression `over`, `${{ ... }}` for templates.
- Check output shape: only agent/program use `.output` envelopes.

## Agent Parse Or Schema Failure

Acpus injects the declared output schema and automatically retries while retry budget remains. If retries are exhausted:

- Read `attempt-NNN.response.md` and `attempt-NNN.transcript.jsonl`.
- Simplify the `output:` schema if it asks for unnecessary nested data.
- Remove schema text from the prompt if the prompt duplicated or contradicted the YAML schema.
- Retry the node if the issue was transient:

  ```sh
  acpus runs retry <runId> --node <nodeKey>
  ```

Use `acpus runs retry <runId>` only when all failed nodes are safe to retry.

## Program Failure

- Read `stdout.log` and `stderr.log` artifacts.
- Non-zero exit codes can be step data when captured; spawn, timeout, capture parse/read, artifact write, and schema failures are node failures.
- Fix deterministic command issues in the spec or workspace, then retry the node when safe.

## Paused Or Awaiting

- `paused` is operator control: use `acpus runs resume <runId>`.
- `awaiting` is a human approval gate: ask the user, then signal the decision:

  ```sh
  acpus runs signal <runId> --node <nodeKey> --approve
  acpus runs signal <runId> --node <nodeKey> --reject
  ```

## Replay

Use replay to validate determinism after a completed Run or when investigating topology drift:

```sh
acpus runs replay <runId>
```

If a Workflow Spec itself is wrong, start a new Run after fixing it. A started Run uses its frozen workflow snapshot.
