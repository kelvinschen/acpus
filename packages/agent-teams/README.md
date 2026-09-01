# ACP Agent Teams

`acp-teams` gives ACP agents a local team control plane: a fixed lead, independent
ACP sessions, atomically claimed tasks, durable direct messages, and coalesced
wake-ups. The agents decide how to divide and revise the work; this package does
not compile their work into a workflow graph.

```sh
acp-teams run --agent trae "Implement the requested change and verify it"
```

Add `--web` to start a read-only local observer for that run:

```sh
acp-teams run --web --agent trae "Implement the requested change and verify it"
```

The CLI prints a loopback URL. The page shows member Turn timelines, task and
dependency state, messages, and the projected trajectory while the foreground
host runs. It never controls or wakes the team. After the team settles, the
final snapshot remains available until Ctrl+C closes the observer; the command
then preserves the team's completed or failed exit status.

Inside every member session, the runtime injects `ACP_TEAM_STATE`, `ACP_TEAM_ID`,
`ACP_TEAM_MEMBER`, and `ACP_TEAM_CLI`. Members use the same executable to inspect
the team, claim or complete tasks, and exchange messages. `ACP_TEAM_MEMBER` is a
trusted-local routing identity, not an authentication credential; fixed-lead
checks define the supported CLI behavior but do not prevent environment or
database tampering by a process with workspace access.

The fixed lead creates a task before spawning its owner:

```sh
node "$ACP_TEAM_CLI" task create --subject "Implement parser" --description "Own parser.ts and run its tests"
node "$ACP_TEAM_CLI" teammate spawn parser-owner --task <task-id> --prompt "Implement and verify only this task"
node "$ACP_TEAM_CLI" wait --timeout-ms 120000
node "$ACP_TEAM_CLI" complete --summary "Integrated and verified"
```

A teammate reads its focused guidance, atomically claims the concrete assigned
task, and writes its verification evidence into the completion result. Direct
messages are for questions, blockers, and coordination rather than a duplicate
completion channel. The supported spawn command creates the teammate, binds the
task, and stores first-turn guidance in one transaction. Turn creation enforces
the team-wide `maxTurns` budget in its admission transaction.

## Protocol and provider boundary

One team run selects one ACP agent and optional model for all members. Separate
runs may choose different configured agents; a single team does not currently
mix providers or per-member models.

The underlying [`@acpus/acp`](../acp/package.json) package pins
`@agentclientprotocol/sdk` 1.3.0 and uses stable ACP wire
`protocolVersion: 1`. Upstream TypeScript SDK 1.4.0 is newer, while native
[delegation](https://github.com/agentclientprotocol/agent-client-protocol/pull/855)
and [`session/fork`](https://agentclientprotocol.com/rfds/updates) remain Draft.
This package depends on neither draft: it opens independent new sessions and
coordinates them through the local CLI and SQLite state.

## Trust boundary

Every member currently runs with Agent Executor `permissionMode: "approve-all"`.
There is no interactive approval, lead-mediated approval, per-member permission
policy, OS-level member isolation, or unforgeable actor identity. Use this MVP
only in a trusted, isolated local workspace without secrets or production
credentials. Direct messages preserve cooperative routing attribution but do
not grant authority or create a security boundary.

On POSIX, an existing state entry must be a regular non-symlink file; the
SQLite database is set to mode `0600`, and managed worker/session directories
are real directories set to `0700`. These defaults limit accidental exposure
across OS users but do not isolate processes running as the same user.

The runtime is foreground-owned. It persists coordination and projected
trajectory evidence in a private SQLite database. On member stop or terminal
settlement, active turns are recorded as `cancelled`; the host explicitly shuts
down the Agent Executor supervisor and waits for member fibers. Shutdown,
session cleanup, or cancellation-persistence failure fails the run instead of
reporting a clean outcome. `SIGINT`, `SIGTERM`, and library-level Effect
interruption use the same settlement path before exit. This release does not
promise daemon operation, nested teams, automatic worktree isolation, or full
ACP session recovery after host failure.

Public inspection and the `--web` observer open existing team state strictly
read-only: inspection does not create or initialize a database, change its file
mode, advance mailbox cursors, or append trajectory events. The observer binds
only to `127.0.0.1`, accepts no team-control requests, and does not expose the
state path to the browser.

## Validation evidence

The fixed [`eval/agent-teams`](../../eval/agent-teams/README.md) fixture records
an R0 baseline, five trajectory-driven optimization iterations (R1-R5), and an
additional real-ACP R6 final hardening regression. R6 passed 7/7 tests with all
members stopped, no current turn or worker ownership file left behind, an
explicitly cancelled lead terminal turn, and the documented owner-only POSIX
state modes. See the compact
[`rounds.json`](../../eval/agent-teams/results/rounds.json) evidence.
