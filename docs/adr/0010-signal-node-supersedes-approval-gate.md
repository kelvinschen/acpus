# Replace the Approval Gate with a general Signal Node

Supersedes the spec-level decision in [0004](0004-awaiting-node-state-for-approval.md). The `awaiting` node state and its in-memory decision channel remain; what changes is the node built on top of them. We are removing the Approval Gate (a fixed approve/reject decision producing `{ approved, decision, at }`) and replacing it with a general **Signal Node** that suspends a Run until an external structured payload is delivered and exposes that payload as `steps.<id>.output`. When the node declares an `output` schema the payload is validated against it (mirroring Agent/Program steps); when omitted any payload object is accepted. Binary approve/reject becomes the degenerate `{ approved: boolean }` schema rather than a built-in primitive.

The goal is to let external instructions steer a Run, not just gate it: an operator (or external system) injects structured data, and existing `switch`/Guard Nodes branch on `steps.<signal>.output.*`. The Signal Node is only the external input source; deterministic branching stays in Guard/`switch`, keeping the two concepts orthogonal as the glossary already separates them.

## Considered Options

- **Add a new node type alongside Approval Gate.** Rejected. Two human-decision nodes sharing one `awaiting` state and one signal channel, differing only in payload richness, is redundant; approve/reject is just a 2-field schema. The codebase is under active iteration (greenfield current behavior), so we delete rather than accumulate.
- **Generalize Approval Gate in place, keeping its name and `approval:` key.** Rejected. The output contract changes from `{ approved, decision, at }` to an arbitrary schema-validated object, which would blur the glossary's clean Approval Gate definition. A renamed concept with a clean contract is clearer than an overloaded one.
- **Make the Signal Node also perform branching/guarding.** Rejected. That re-merges "external human input" with "deterministic automatic branch" — exactly the distinction CONTEXT.md keeps between Signal Node, Guard Node, and Run Control. Signal injects data; `switch`/Guard route on it.
- **Make payload durable across supervisor restart for the Signal Node now.** Rejected for v1. It would give Signal Nodes different restart semantics than the rest of the `awaiting` family for no consumer-driven reason. Durable decision recovery stays deferred for the whole family and should be designed once, against real consumers.

## Decision

- A Signal Node is an Executable Node declared with `run: signal`, parallel to `run: agent` / `run: program`.
- It declares `prompt` (operator-facing description) and MAY declare `output` (Acpus Schema DSL). When `output` is declared the externally injected payload MUST validate against it; a non-conforming signal is rejected (422) and the node keeps `awaiting`. When `output` is omitted any payload object is accepted, mirroring Agent/Program steps.
- `steps.<id>.output` is exactly the injected object — no `decision`/`at` envelope metadata. Downstream timestamps come from `now()`.
- Timeout policy is `on_timeout: fail | default`. `default` carries a literal payload validated against `output` at compile time (when a schema is declared), so an invalid default is a lint error, not a runtime surprise.
- The decision channel keeps the existing in-memory, live-run-only model: `POST /runs/:runId/signal?key=<nodeKey>` with the JSON body as the payload directly (no `kind` discriminator, no `{ payload }` wrapper). No live interpreter ⇒ 409.

## Consequences

- The node state machine is unchanged: `awaiting` and its transitions (`running → awaiting → {completed, cancelled}`) carry over verbatim from 0004; only the producer of `awaiting` changes.
- This is a breaking change to the Workflow Spec surface: `approval:` / `run: approval`, the `{ approved, decision, at }` output shape, and the `approve`/`reject` signal body are removed. Specs and tests describe only the Signal Node going forward.
- Durable decision recovery remains deferred for the entire `awaiting` family (see roadmap); an `awaiting` Signal Node resets to `pending` on supervisor restart and re-awaits a fresh signal, and any payload submitted before a crash is lost.
- The `/runs/:runId/signal` HTTP path and the CLI `acpus runs signal` verb are retained but generalized: the CLI delivers a structured payload via `--payload <value>` (inline JSON or a path to a JSON/YAML file) instead of `--approve`/`--reject`.
