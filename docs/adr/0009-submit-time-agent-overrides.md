# Use submit-time Agent Overrides for Run agent selection

Acpus will support changing agent selection at Run creation by applying explicit Agent Overrides to a Workflow Spec before compilation, then freezing the resulting IR for that Run. This preserves the `Run = frozen workflow snapshot` model: resume, retry, replay, and execution read the frozen IR rather than a mutable override source, while Run metadata records the effective override map and submission warnings for auditability and future fork inheritance.

## Considered Options

- **Runtime agent switching inside an existing Run.** Rejected because it would introduce mutable execution state outside the frozen IR, complicating Replay, Node Definition Hashes, Agent Step continuation, and Forked Run inheritance.
- **Submit-time overrides that are not persisted.** Rejected because Forked Runs would lose the agent choice that produced the source Run, making common Program Step repairs unexpectedly re-execute Agent Steps or switch back to the repaired Spec's defaults.
- **Persist only effective agent definitions.** Rejected because Forked Runs should inherit the user's override intent and reapply it to the repaired Workflow Spec, rather than copying an expanded agent definition from an older Spec.

## Consequences

Forked Runs inherit the source Run's effective Agent Override map by default, merge any current fork overrides on top, and persist the resulting single-layer map as the new Run's Agent Overrides. Agent Overrides affect Node Definition Hashes only through the effective frozen IR: changing an agent definition for a referenced Agent Step changes that Step's hash and can move the Fork Origin, while equivalent effective IR remains hash-equivalent regardless of whether it came from the Spec or from overrides. Agent Overrides are scoped to the submitted top-level Workflow Spec; subworkflow override scoping is intentionally deferred.
