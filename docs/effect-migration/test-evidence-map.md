# Test Evidence Map

This map connects migration invariants/races to existing test areas. It is a
Master routing aid, not permission to blindly rewrite tests. Before changing a
test, follow `docs/testing-maintenance.md` and inspect the exact current test.

## Evidence strategy

Use the lowest stable boundary that observes the risk. Existing semantic tests
are preferred as migration oracles. If an implementation-specific Promise/timer
assertion must change, preserve the semantic risk with a focused replacement.

## Scheduler / store

| IDs | Existing evidence to locate first | Typical WP |
| --- | --- | --- |
| SCH-001, STORE-001 | scheduler fencing / owner epoch / lease-loss integration tests | B01, D02-D04 |
| SCH-003, SCH-004 | scheduler runner / attempt start+commit integration tests | D02 |
| SCH-005 | scheduler retry / targeted retry / control retry tests | D02-D04 |
| SCH-006 | scheduler transition/reducer unit tests | preserve, normally untouched |
| STORE-002, STORE-003 | runtime store transaction, WAL/recovery, idempotency tests | B01 |
| RACE-001..004 | scheduler control, fencing, cancellation, runner integration tests | D02-D04 |
| RACE-005 | wakeup/mutation ordering tests; add focused unit test if absent | D01 |

Required review: do not weaken a fencing/idempotency/replay assertion merely
because the new Effect control flow is harder to drive.

## Workspace / daemon

| IDs | Existing evidence to locate first | Typical WP |
| --- | --- | --- |
| AUTH-001, AUTH-002 | runtime authority/daemon lease tests | C05 |
| LIFE-001, LIFE-002 | workspace open/close, daemon lifecycle tests | C05 |
| RACE-006, RACE-007 | shutdown/authority-loss integration tests | C05 |
| LOCAL-002 | mutation queue ordering/drain tests | D01 |

New Effect tests should use controlled time for heartbeat/tick semantics where
possible rather than replacing one arbitrary sleep with another.

## Agent executor / process capsule

| IDs | Existing evidence to locate first | Typical WP |
| --- | --- | --- |
| PROC-002, PROC-003 | process capsule/process-tree cleanup tests | C02 |
| ACP-001, LIFE-004 | ACP ownership manifest/session process lifecycle tests | C02 |
| ACP-002, ACP-003, LIFE-005 | session supervisor lease/neutralize/shutdown tests | C04 |
| RACE-008..011, RACE-015 | process exit/open cancellation/turn deadline/supervisor shutdown tests | C02,C04 |

Real subprocess tests are appropriate where OS process behavior is the risk;
Effect time control does not replace an actual process test when process-group
or signal behavior is the contract.

## ACP package

| IDs | Existing evidence to locate first | Typical WP |
| --- | --- | --- |
| ACP-004, ACP-005, LIFE-006 | ACP session open/resume/turn/close tests | C03 |
| ACP-006, LIFE-007 | reverse RPC permission/path/terminal/file tests | C03 |
| RACE-012, RACE-013 | session close/pending RPC and cancellation tests | C03 |
| RACE-014 | failure + cleanup/finalizer composition tests | C02-C05,D04 |

## Runtime agent integration

The branch contains large runtime integration coverage such as
`packages/runtime/test/agent-node.integration.test.ts` and ownership/observation
integration tests. Use these as end-to-end semantic evidence after narrower
package tests, not as the only debugging oracle.

## Work-package evidence record

Every WP lists concrete test paths after inspection:

```text
Invariant/race ID:
Existing test path + case name:
Why it observes the risk:
Keep unchanged / adapt / add focused replacement:
Narrow command:
Broader command:
```

If no existing test observes a high-risk invariant, add the smallest focused
test before or with the implementation. Do not manufacture tests for internal
Fiber ids, Layer topology or exact combinator choice.
