# Local Runtime Target Spec

## Purpose

Acpus runtime execution is a local CLI orchestration boundary for durable single-host workflows that run local ACP agents and local programs.

## Requirements

- The runtime MUST execute as a local CLI tool on a single host.
- The runtime MUST schedule Workflow Nodes through the local durable execution engine used by Acpus.
- The runtime MUST run Agent Steps against local ACP-compatible agents through acpx.
- The runtime MUST delegate ACP session lifecycle, queue ownership, session loading, session resumption, and cooperative session cancellation to acpx.
- The runtime MUST run Program Steps as local subprocesses on the same host.
- The runtime MUST NOT provide distributed execution across multiple hosts.
- The runtime MUST NOT route Agent Steps or Program Steps to remote workers.
- The runtime MUST NOT require a shared Temporal cluster for normal operation.
- The runtime MUST NOT require cross-host workspace transfer, remote task queues, or worker affinity.
- The runtime MUST treat acpx as the local ACP session scheduler, not as the Workflow scheduler.
- The runtime MUST treat Acpus as the Workflow scheduler and the source of Node state, retry, timeout, pause, resume, cancel, and artifact-reference decisions.
- The runtime MAY use an embedded or local Temporal-compatible service as its durable execution engine.
- The runtime MAY support explicit development or diagnostic commands that connect to external services, but those commands MUST NOT change the core runtime target from single-host local orchestration.

## Verification

- Runtime tests MUST cover that Agent Steps are invoked through acpx rather than direct ACP session management by Acpus.
- Runtime tests MUST cover that Program Steps execute as local subprocesses.
- Runtime tests MUST cover that workflow retry, timeout, pause, resume, and cancel decisions remain owned by Acpus.
- Runtime tests MUST cover that acpx session names are explicit and stable enough for Node-level continuation.
- Runtime tests MUST cover that normal runtime execution does not require remote workers, remote task queues, or a shared Temporal cluster.
