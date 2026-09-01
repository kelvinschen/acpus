# ADR-0003: Independent ACP Agent Teams Runtime

- Status: Accepted
- Date: 2026-08-24
- Implementation status: MVP implemented and validated with a real ACP agent
- Depends on: [ADR-0001](0001-effect-runtime-foundation.md), [ADR-0002](0002-effect-v4-runtime-baseline.md)
- Decision owners: Acpus maintainers

## Context

Acpus workflows are authored as typed static graphs, compiled into frozen IR,
and advanced by a durable scheduler. Agent Teams solve a different problem:
several independent agent sessions coordinate through a task board and direct
messages, and choose work dynamically while the team is running.

Treating team tasks as workflow nodes would either make runtime-created topology
look static or add dynamic exceptions to the workflow scheduler. Both choices
would weaken the workflow contract. Reimplementing ACP process and session
management inside a team package would duplicate the ownership, cancellation,
and settlement guarantees already provided by `@acpus/agent-executor`.

The first useful version also needs to be selectable across ACP agents. A team
run selects one provider and model for all of its members; separate team runs
may select different configured agents. ACP v1 defines client/agent sessions,
turns, updates, terminal operations, and capability negotiation; it does not
define team membership, shared tasks, or peer mailboxes. The coordination
interface therefore has to sit above ACP without requiring a provider-specific
protocol extension.

## Decision

### ACP protocol baseline

The implementation pins `@agentclientprotocol/sdk` 1.3.0, uses its stable v1
entry point, and sends and accepts wire `protocolVersion: 1`. The upstream
TypeScript SDK release was 1.4.0 when this decision was validated; package
version and wire protocol version are separate compatibility dimensions.

The upstream [delegation proposal](https://github.com/agentclientprotocol/agent-client-protocol/pull/855)
and [`session/fork` RFD](https://agentclientprotocol.com/rfds/updates) are both
Draft. Agent Teams depends on neither: every member is a newly opened ACP
session and all team coordination remains in this package's CLI and database.

### Independent package and product boundary

Acpus implements Agent Teams in a separate `@acpus/agent-teams` package.

The package owns team membership, dynamic tasks and dependencies, task claims,
mailboxes, wake decisions, and trajectory records. It does not compile workflow
IR and does not call the workflow scheduler. `@acpus/runtime` remains the sole
owner of durable workflow semantics.

### Reuse Agent Executor

Every team member runs in an independent ACP session acquired through
`@acpus/agent-executor`. The team runtime supplies member identity, prompts,
working directory, and turn intent; Agent Executor remains responsible for
agent resolution, the exclusive session lease, ACP lifecycle, cancellation,
turn settlement, ownership evidence, and owned-process cleanup.

The team database never treats raw ACP frames or provider process state as
coordination authority. ACP observations may be recorded in the trajectory,
while task and mailbox state change only through team operations.

### CLI as the agent control plane

Team operations are exposed as CLI commands. A member invokes those commands
through the terminal capability already available to an ACP agent. The host
injects team state, executable, and member context into the member's execution
environment; commands resolve their actor from that session context rather than
accepting an actor option in the model-generated command.

The injected `ACP_TEAM_MEMBER` value is a routing identity for trusted local
cooperation, not an authentication credential. CLI role checks define the
supported command surface; they do not prevent a process that can replace the
environment or write the database from impersonating another member.

This makes the agent-computer interface uniform across ACP providers and keeps
the MVP independent of model-native tool injection. A daemon, network service,
or MCP server is not part of this decision. A bounded `wait` command may observe
the shared task state until completion, team settlement, or timeout so an agent
does not have to spend tool calls on an ad hoc polling loop; it does not acquire
a member session or become a scheduler.

### Fixed topology

Each team has one lead fixed for its lifetime. Only the lead can add teammates.
Teammates cannot create nested teams or transfer leadership. Member names are
unique within the team and address task ownership and mailbox recipients.

The fixed root keeps coordination ownership, synthesis, and shutdown
unambiguous. It is a role check in the supported CLI, not an adversarial
security boundary. More general membership graphs require a separate future
decision.

### Trusted-workspace permission model

Every member session currently uses Agent Executor
`permissionMode: "approve-all"`. The MVP has no interactive approval flow,
lead-mediated approval, per-member permission policy, OS-level member isolation,
signed actor identity, or capability token. It is supported only for a trusted,
isolated local workspace; fixed-lead role checks and mailbox attribution must
not be presented as protection from a malicious teammate or process.

The local state boundary still applies least-access filesystem defaults: an
existing state path must be a regular non-symlink file, the SQLite file is mode
`0600`, and managed worker/session directories are real directories set to mode
`0700`. These controls reduce accidental exposure across OS users; they do not
authenticate members or isolate processes running as the same user.

### SQLite is coordination authority

Each private SQLite database belongs to exactly one team and is the authoritative
record for that team's members, tasks, dependencies, mailboxes, trajectory
entries, and wake state. Creating a second team in the same database is rejected.
All accepted mutations are transactions. Task claim uses compare-and-swap with
a pending-task predicate and rechecks current status, owner, and dependency
readiness in the committing transaction.

The supported teammate-spawn command creates the member, binds its assigned
task, and writes first-turn guidance in one transaction; an invalid guidance
message leaves no partial teammate or assignment. Turn admission also counts
all team turns and enforces `maxTurns` inside the transaction that creates the
turn, so concurrent members cannot over-admit against the shared budget.

The database representation is private. The durable semantic boundary is that
only one claimant can win, blocked work cannot be claimed, and rejected
mutations leave state unchanged. Accepted team create/complete/fail, member
spawn/fail/stop/nudge, task create/claim/complete, direct-message send, and turn
start/finish/cancel operations commit their trajectory event with their state
change. Accepted ACP observations append their own event. Advancing an inbox
cursor is read progress and deliberately has no journal event.

### Persistent wake generation

Each member has a monotonic wake generation. A committed task, message, or nudge
that may change that member's next action advances its generation in the same
transaction. The foreground host tracks the generation handled by each member
and starts a new turn only when a newer generation is pending.

Wake generation is an observation cursor, not a second scheduler or a source of
truth. It prevents a short-lived CLI process from losing a committed wake and
coalesces multiple changes before a member's next turn. A wake never bypasses
task CAS or mailbox state.

### Foreground lifecycle and evidence

The MVP is owned by one foreground host. That host owns live Agent Executor
leases, dispatches member turns, and performs orderly cleanup on exit. CLI
operations can inspect or mutate the host-owned team state but do not create a
background runtime or independently acquire member sessions.

On team settlement the host aborts member controllers, explicitly shuts down
the Agent Executor supervisor, waits for all member fibers, and records any
remaining active turn as `cancelled` with a `turn_cancelled` event. A requested
member stop likewise records an interrupted active turn as `cancelled` rather
than pretending it completed. Supervisor shutdown, session cleanup, or
cancellation-persistence failure makes the run fail even if the
coordination database already has a terminal team status.

The executable bridges `SIGINT` and `SIGTERM` into Effect interruption. The
runtime interruption finalizer first fails an active team, then uses the same
turn cancellation, supervisor shutdown, and member-fiber settlement path.
Library callers receive the same guarantee when the returned Effect is
interrupted. A pure requested fiber interruption is not recorded as a cleanup
failure; actual cleanup defects remain visible.

The package records an ordered trajectory of coordination mutations and turn
evidence. High-volume ACP events are projected into bounded diagnostic evidence;
the trajectory is not an unabridged wire transcript. Trajectory is used to
diagnose and improve the agent-computer interface; it is not a substitute for
Agent Executor ownership evidence or an ACP session recovery projection.

This decision does not claim full crash recovery of live members. Persisted
coordination data surviving a host failure is necessary evidence, but resuming
or replacing provider sessions safely requires a later recovery contract.

## Validation record

The MVP was validated on 2026-08-24 with Trae 0.201.4 through its native ACP
interface. All sessions used `permissionMode: "approve-all"` in fresh, trusted
temporary fixture copies without credentials or secrets. A fixed, initially
failing fixture was used for a baseline and five trajectory-driven optimization
runs. Every run created one lead and three independent teammate sessions,
completed three dynamically claimed tasks, and finished with all seven fixture
tests passing without test edits.

The baseline exposed redundant worker turns, shell-expanded message text, an
unsettled durable lead turn, and a journal dominated by unclassified ACP events.
The five iterations successively settled terminal turns and removed redundant
wakes, projected bounded ACP evidence, made task results the authoritative
completion handoff, added bounded task waiting, and rendered concrete task IDs
in teammate commands. In the last run there were four turns total, three direct
guidance messages, three successful claims, no placeholder claim, one wait, and
no member with a current turn after completion.

Review after R5 added atomic spawn-and-guidance, transactional turn-budget
admission, explicit cancelled-turn recording, supervisor shutdown with member
fiber settlement, cleanup-failure propagation, private filesystem modes, and
state-symlink rejection. These were not retroactively present in the R0-R5 raw
trajectory comparison. An additional real-ACP R6 final hardening regression
exercised the reviewed implementation; it supplements rather than replaces the
five R1-R5 optimization iterations.

R6 completed in 110,216 ms with three completed teammate turns and one explicitly
cancelled lead terminal turn, three direct guidance messages, 177 journal events,
three provider outcomes reporting 415,358 total tokens, and all seven fixture
tests passing. All members finished `stopped` with `currentTurnId=null`, worker
ownership files were empty, and the SQLite and managed directory modes were
`0600` and `0700`, respectively. Its projected trajectory view was 228,946 bytes.
After R6, an automated integration run with an ACP fixture subprocess sent
`SIGINT` during an active prompt and verified a failed team, cancelled Turn,
stopped lead, empty ownership directory, dead Agent process, and CLI exit 130.

This is evidence for the MVP boundary, not a portability or performance claim.
There was one nondeterministic sample per iteration, only one ACP provider was
used, and elapsed time and provider-reported tokens did not improve monotonically.
The raw SQLite databases and exported transcripts remain local validation
artifacts; the repository keeps only compact run evidence and the fixed fixture.

## Consequences

### Positive

- Workflow IR and scheduler semantics remain static and internally coherent.
- Separate team runs can select any configured ACP provider supported by Agent
  Executor; all members of one team use that run's provider and model.
- Agents receive one provider-neutral coordination interface through the CLI.
- SQLite transactions make task claims, dependencies, messages, and trajectory
  evidence coherent under concurrent CLI calls.
- Atomic spawn guidance and turn-budget admission prevent partially visible
  teammates and concurrent budget overrun.
- Wake generation gives the foreground host event-driven, restart-visible
  coordination without introducing a daemon.
- Explicit cancellation and cleanup failure propagation prevent a terminal team
  record from being mistaken for a cleanly settled runtime.
- Real trajectories expose prompt and tool-interface failures for iterative
  improvement.

### Costs

- Agent Teams have a separate state machine and storage boundary to maintain.
- Independent sessions multiply token and process cost.
- Agents can still make poor decomposition or completion decisions; the control
  plane can enforce legal transitions but cannot guarantee useful work.
- A foreground host limits unattended lifetime and does not by itself provide
  complete crash resume.
- Shared workspace edits remain an external collaboration concern; task
  ownership does not imply automatic file isolation or merge conflict handling.
- `approve-all` and environment-routed member identity provide no adversarial
  isolation; callers must supply a trusted, isolated workspace.

## Rejected alternatives

### Express team work as a dynamic workflow

Rejected. Runtime-created tasks, peer messages, and self-claiming do not fit a
compiled frozen graph. Adding exceptions would make workflow replay and
scheduler authority conditional on agent behavior.

### Reuse the workflow Runtime but bypass its scheduler

Rejected. Sharing persistence while bypassing scheduling would create two
writers with different ownership and recovery semantics under one runtime
boundary.

### Implement ACP sessions directly in Agent Teams

Rejected. It would duplicate binding resolution, leases, cancellation, turn
settlement, process ownership, and cleanup, and would let the two products drift
at their most safety-sensitive boundary.

### Copy Claude Code's JSON directories and file locks

Rejected. Those layouts are implementation details that changed across Claude
Code releases. SQLite provides atomic multi-record invariants without claiming
compatibility with an experimental private format.

### Make MCP the initial coordination surface

Rejected for the MVP. ACP terminal operations already provide a common route to
the CLI. MCP would add another lifecycle and configuration boundary before the
core team state machine has been validated with real agents.

### Allow nested teams or lead transfer

Rejected for the MVP. They complicate authority, resource ownership, wake
routing, synthesis, and shutdown without being required to validate the core
Agent Teams model.

## Follow-up boundary

A background host, remote control plane, MCP adapter, interactive or per-member
permission policy, adversarial member isolation, lead transfer, nested teams,
automatic workspace isolation, or complete crash-resume semantics each require
an explicit follow-up design. None should be inferred from persisted tasks,
mailbox messages, trajectory, or ACP session support in this MVP.
