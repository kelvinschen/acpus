# Acpus

Acpus is a workflow authoring and orchestration context for durable ACP agent work. The language below names workflow concepts, not implementation modules.

## Language

**Workflow Spec**:
A YAML document that declares a workflow, its inputs, agents, steps, and outputs.
_Avoid_: config file, script

**Workflow Catalog**:
A discoverable collection of Workflow Specs that Acpus can list, inspect, lint, and run by reference. The Catalog contains Workflow definitions, not Run history or runtime state.
_Avoid_: run list, registry database, saved run

**Workflow**:
The logical process described by a Workflow Spec.
_Avoid_: job, pipeline

**Workspace**:
The current local directory boundary whose Workflow Specs, Runs, artifacts, and execution context are managed together. By default, Acpus treats the process current working directory as the Workspace.
_Avoid_: global environment, repository root, spec directory

**Run**:
One submitted execution of a Workflow with frozen inputs and a frozen workflow snapshot.
_Avoid_: session, invocation

**Node**:
A stable, addressable unit inside a Workflow.
_Avoid_: task, stage

**Composite Node**:
A Node that controls other Nodes, such as parallel, fanout, switch, loop, or subworkflow.
_Avoid_: container step, control block

**Guard Node**:
An automatic deterministic decision point that evaluates a condition and either continues, fails, or completes the current Workflow scope. A Guard Node is distinct from an Approval Gate because it does not wait for a human decision, and distinct from Run Control because it is declared business flow inside the Workflow.
_Avoid_: approval gate, pause, cancel, manual checkpoint

**Executable Node**:
A Node that performs external work through an Agent Step or Program Step.
_Avoid_: leaf task, action

**Agent Step**:
An Executable Node that prompts an ACP-compatible agent and expects a structured output object.
_Avoid_: AI task, model call

**Agent Override**:
A submit-time override of a Workflow Spec's top-level agent definitions used when creating a Run or Forked Run. Agent Overrides affect the frozen IR created for that Run and do not mutate or control an already-started Run.
_Avoid_: runtime agent switch, node control

**Program Step**:
An Executable Node that runs a local command and records command output.
_Avoid_: shell task, script step

**Approval Gate**:
A human decision point inside a Workflow. While blocked on a decision a Gate is `awaiting`; a human approve/reject resolves it, distinct from operator pause.
_Avoid_: pause, manual stop

**Mock Agent**:
An ACP-compatible Agent used to produce deterministic responses for repeatable Workflow testing.
_Avoid_: fake runtime, simulator

**Node Key**:
A stable filesystem-safe string that identifies a Node within a Run, resolved from the IR NodeKeyTemplate plus runtime dynamic context (loop round, fanout item, parallel branch).
_Avoid_: task id, step path

**Node State Machine**:
A unified 7-state lifecycle (pending → running → {awaiting, completed, failed, paused, cancelled}) governing every Node in a Run. `awaiting` is the human-decision wait used by Approval Gates.
_Avoid_: status enum, phase tracker

**Run Control**:
An operator action that applies to the whole Run, such as pause, resume, cancel, or retry.
_Avoid_: node control, task control

**Node Retry**:
An operator repair action that re-executes one failed Executable Node without implying broader Workflow progress.
_Avoid_: node resume, node pause, task retry

**Continuation**:
The Agent Step execution mode that re-enters the same acpx-managed ACP session with a fixed runtime prompt, used by Run-level resume and Node Retry.
_Avoid_: node resume, rerun prompt

**Run Supervisor**:
A Workspace-scoped local execution authority that owns active Run interpreters, persists Node state, and lets other terminals observe or control Runs. It is an implementation detail of Run execution, not a prerequisite the user must manually start.
_Avoid_: daemon, server, service

**Run Observation**:
A concise view of Run or Node state changes derived from persisted Run state for human-facing follow and watch displays. Run Observations include a Run's Forked Run lineage when present. Run Observations are not an append-only event history, raw Program stdout, Agent transcripts, or logs.
_Avoid_: event history, log line, stdout, transcript event

**Served Visualizer**:
A browser-accessible view of the existing visualizer for observing Runs from another machine. A Served Visualizer is an observation surface, not a standalone Web UI or remote Run Control surface.
_Avoid_: Web UI, dashboard, remote control plane

**Artifact**:
A durable file produced by a Node execution (transcript, stdout capture, etc.) stored on disk and referenced by URI.
_Avoid_: output file, blob

**Replay**:
A read-only re-interpretation of a finished Run against its frozen snapshot and recorded Node outcomes, used to verify that the same inputs reproduce the same Node topology.
_Avoid_: re-run, rerun, simulation

**Run Checkpoint**:
An ordered, persisted record of one Node's terminal outcome within a Run, capturing Node Key, terminal state, Node Definition Hash, output, artifact references, and error summary. Run Checkpoints are the inheritance source consulted when a Forked Run decides which Nodes to reuse.
_Avoid_: snapshot, log entry, event

**Node Definition Hash**:
A stable canonical hash of a Node's compiled IR, including the full subtree for a Composite Node. Two Nodes with equal Node Key and equal Node Definition Hash are treated as the same Node across Runs for the purpose of Forked Run inheritance.
_Avoid_: spec hash, yaml hash

**Forked Run**:
A new Run derived from a prior Run by supplying a possibly-modified Workflow Spec. The Forked Run scans the prior Run's Run Checkpoints in order and inherits each Node whose Node Key exists in the new Spec, whose prior state is `completed`, and whose Node Definition Hash matches; inheritance stops at the first Node that fails any of these checks (the inheritance boundary), and the boundary Node plus everything after it executes fresh. A Forked Run is its own Run with its own frozen snapshot and does not mutate the prior Run. Reused outputs and any runtime-context values they depended on (such as `run_id` or `now()` derivations) are accepted as historical facts and are not recomputed. A Forked Run records only its immediate prior Run as lineage; when a Forked Run is itself forked, the new Run treats the previous Forked Run as a standard prior Run and does not carry deeper ancestry.
_Avoid_: rerun, replay, resumed run, branched run

**Fork Origin**:
The Node Key at which a Forked Run begins fresh execution. By default the Fork Origin is the inheritance boundary determined automatically from Run Checkpoint scanning; an operator MAY override it to force an earlier restart. A Fork Origin MUST be a top-level Node or a Composite Node, never a Node inside a Composite's body, because the dynamic context (loop round, fanout item, parallel branch) of inner Nodes is determined by the surrounding Composite at execution time.
_Avoid_: restart point, retry node, fork point
