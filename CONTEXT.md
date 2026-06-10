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
A concise view of Run or Node state changes derived from persisted Run state for human-facing follow and watch displays. Run Observations are not an append-only event history, raw Program stdout, Agent transcripts, or logs.
_Avoid_: event history, log line, stdout, transcript event

**Artifact**:
A durable file produced by a Node execution (transcript, stdout capture, etc.) stored on disk and referenced by URI.
_Avoid_: output file, blob

**Replay**:
A read-only re-interpretation of a finished Run against its frozen snapshot and recorded Node outcomes, used to verify that the same inputs reproduce the same Node topology.
_Avoid_: re-run, rerun, simulation
