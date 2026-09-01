# Agent Teams Evaluation Fixture

This fixed, dependency-free Node.js project evaluates whether one lead can
delegate three independent implementation tasks and then integrate the results.
The fixture is intentionally incomplete: its tests fail until the TODOs in
`src/` are implemented.

Do not change the tests during an evaluation.

## Work split

All three teammate tasks consume the same run records and can be completed in
parallel. They must not import one another.

1. `src/quality.js` — implement `summarizeQuality(runs)`.
   - Accept only `completed`, `failed`, and `cancelled` statuses.
   - Return exact counts, a success rate rounded to four decimal places, and
     unsuccessful run ids in input order.
   - Return zero counts and a zero rate for an empty input.
   - Do not mutate the input.
2. `src/latency.js` — implement `summarizeLatency(runs)`.
   - Require every `durationMs` to be a finite non-negative number.
   - Return count, minimum, maximum, arithmetic mean rounded to two decimal
     places, and nearest-rank p95.
   - Return `null` for all four measurements when the input is empty.
   - Do not mutate the input.
3. `src/usage.js` — implement `summarizeUsage(runs)`.
   - Treat missing token fields as zero and reject negative, fractional, or
     non-finite values.
   - `totalTokens` is input plus output; cache-read tokens are reported
     separately because they are already part of provider input accounting.
   - Return zero totals for an empty input and do not mutate it.

After the three tasks pass independently, the lead owns `src/report.js`:

- Compose the three summaries without duplicating their logic.
- Set assessment status to `needs-attention` when success rate is below `0.8`
  and/or p95 latency is above `250ms`; otherwise use `healthy`.
- Emit reasons in this fixed order: `success_rate_below_0.8`, then
  `p95_above_250ms`.

The integration test is deliberately separate so teammate unit tests can pass
while the full evaluation still requires lead integration.

## Acceptance

From this directory, run:

```bash
node --test
```

The untouched fixture is expected to fail all seven tests with explicit TODO
errors. A completed evaluation must pass all seven tests without third-party
packages, network access, generated fixtures, or test edits.

`trajectory/` and `results/` are reserved for real evaluation evidence and its
retention notes. Do not create synthetic run evidence.

## Validation boundary

The recorded R0-R6 runs used fresh temporary copies of this fixture, Trae
0.201.4 for every member in a team, and Agent Executor
`permissionMode: "approve-all"`. This fixture is intentionally dependency-free,
isolated, and free of credentials or secrets; the results do not establish
interactive approval, per-member permissions, or adversarial teammate
isolation. `ACP_TEAM_MEMBER` supplied member routing for the cooperative CLI but
was not an unforgeable security identity.

Those runs traversed Acpus' pinned `@agentclientprotocol/sdk` 1.3.0 client on
ACP wire `protocolVersion: 1`. They opened independent new sessions and did not
exercise the upstream Draft delegation or `session/fork` proposals. Compact
run evidence is in [`results/rounds.json`](results/rounds.json), with raw
trajectory retention documented in [`trajectory/README.md`](trajectory/README.md).

R0 is the baseline and R1-R5 are the five trajectory-driven optimization
iterations. Those records intentionally remain historical evidence. Review
after R5 added atomic spawn-and-guidance, transactional team turn-budget
admission, explicit `cancelled` Turn records, supervisor shutdown plus member
fiber settlement, cleanup-failure propagation, private filesystem modes, and
state-symlink rejection.

R6 is an additional real-ACP final hardening regression, not a replacement for
the five optimization iterations. It passed 7/7 tests in 110,216 ms with four
durable turns (three completed teammate turns and one cancelled lead terminal
turn), three messages, 177 events, three provider outcomes reporting 415,358
total tokens, and a 228,946-byte trajectory view. Every member ended `stopped`
with `currentTurnId=null`; worker ownership files were empty, the state database
was mode `0600`, and managed worker/session directories were mode `0700`.
