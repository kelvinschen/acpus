# ACPX Workflow Orchestrator

This context defines the repository language used to separate normative design specifications, developer-facing documentation, historical records, and agent-facing maintenance rules.

## Language

**Specification**:
A normative, up-to-date design and implementation contract for a project module. Specifications use structured language and define current behavior, interfaces, invariants, and implementation responsibilities.
_Avoid_: design doc, plan, proposal

**Developer Documentation**:
Readable explanatory material intended to help developers understand, use, or troubleshoot the project. Developer documentation may reference specifications but is not itself normative.
_Avoid_: spec, implementation contract

**Historical Archive**:
Non-normative records of past plans, validation runs, handoffs, investigations, or decisions that are preserved for context. Archived material must not be treated as current implementation truth.
_Avoid_: current docs, active plan

**Roadmap**:
Non-normative future work, accepted direction that is not yet implemented, or known capability gaps. Roadmap material must not be treated as current implementation truth.
_Avoid_: specification, historical archive

**Agent Instruction**:
Repository-level rules that constrain AI agents working on code changes. Agent instructions define required maintenance behavior for specifications and documentation.
_Avoid_: agent spec, contributor guide

**Agent Concurrency**:
The number of agent work units that may be active at the same time. Agent concurrency is not a count of internal agent calls made by repair or retry behavior inside one active work unit.
_Avoid_: agent call budget, total agent calls

**Agent Call**:
A runtime interaction with an agent used for usage reporting and attempt accounting. Agent calls are distinct from agent concurrency.
_Avoid_: active agent, concurrency slot

**Heterogeneous Fanout**:
A fanout pattern where work items, or lanes for the same work item, may be assigned to different roles or agents within one fanout stage.
_Avoid_: multi-agent fanout, mixed-agent fanout, agent selection fanout

**Workflow-Level Bounded Loop**:
A workflow control pattern that repeats a bounded set of workflow stages until an explicit exit condition is met or a configured round limit is exhausted.
_Avoid_: generalized fixLoop, arbitrary cycle, workflow recursion

**Loop Body**:
The scoped set of stages repeated by a Workflow-Level Bounded Loop. A Loop Body is part of the loop container, not a set of top-level workflow stages.
_Avoid_: referenced stages, top-level loop stages

**Loop Body Output**:
The explicitly selected Loop Body stage output that represents the result of one Loop Round. A Loop Body Output is chosen by loop configuration rather than inferred from terminal body stages.
_Avoid_: inferred terminal output, last body stage

**Loop Round**:
One complete execution of a Loop Body within a Workflow-Level Bounded Loop. Loop continuation or exit is evaluated at Loop Round boundaries.
_Avoid_: iteration step, partial round, mid-loop break

**Loop Output**:
The top-level stage output emitted by a Workflow-Level Bounded Loop. A Loop Output summarizes the latest round and preserves round history without promoting Loop Body stage outputs to top-level workflow outputs.
_Avoid_: flattened body outputs, final body stage output

**Lane**:
A named execution channel within heterogeneous fanout that binds selected work items to a role and prompt.
_Avoid_: agent option, branch

**Lane Group**:
A named set of lanes evaluated together for each fanout item under one selection mode.
_Avoid_: lane selector, lane collection
