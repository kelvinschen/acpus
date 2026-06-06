# Acpus

Acpus is a workflow authoring and orchestration context for durable ACP agent work. The language below names workflow concepts, not implementation modules.

## Language

**Workflow Spec**:
A YAML document that declares a workflow, its inputs, agents, steps, and outputs.
_Avoid_: config file, script

**Workflow**:
The logical process described by a Workflow Spec.
_Avoid_: job, pipeline

**Run**:
One submitted execution of a Workflow with frozen inputs and a frozen workflow snapshot.
_Avoid_: session, invocation

**Node**:
A stable, addressable unit inside a Workflow.
_Avoid_: task, stage

**Composite Node**:
A Node that controls other Nodes, such as parallel, fanout, switch, loop, or subworkflow.
_Avoid_: container step, control block

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
A planned human decision point inside a Workflow.
_Avoid_: pause, manual stop

**Mock Agent**:
An ACP-compatible Agent used to produce deterministic responses for repeatable Workflow testing.
_Avoid_: fake runtime, simulator
