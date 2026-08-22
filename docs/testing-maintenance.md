# Testing Maintenance Guide

This is the authority for tests, test configuration, and test scripts. Tests
provide focused evidence for production contracts.

For Effect-specific Scope, Layer, Clock, and runner examples, consult the
optional [Effect Testing pattern](effect/patterns/testing.md). It is subordinate
to this guide and does not make Effect syntax a testing goal.

## Scope

- Every test MUST protect a realistic observable regression risk, non-trivial
  invariant or boundary, or concrete defect at the lowest stable production
  boundary. A code change or coverage increase alone does not justify a test.
- Informative assets are not product-test subjects or oracles. Follow
  [Skill Maintenance](skill-maintenance.md) for their scope.
- Product code that handles an informative asset remains testable; use the
  smallest synthetic fixture instead of real repository content.
- Link, format, and generated-file checks are repository hygiene, not product
  behavior evidence.

## Choose the Layer

| Layer | Use for |
| --- | --- |
| Unit | One rule, transformation, or state transition. |
| Type | Public TypeScript acceptance and rejection. |
| Contract | Public APIs, diagnostics, serialized shapes, and protocols. |
| Integration | Cooperation across owned component boundaries. |
| End-to-end | One high-value workflow through the real product surface. |
| Regression | The smallest reproduction of a fixed defect. |

Use a higher layer only when a lower one cannot observe the risk. Do not repeat
the same assertion at every layer.

## Test Design

- Give each test one dominant reason to fail; its name and diff should identify
  the violated rule.
- Keep setup smaller than the behavior under test and expose the variable under
  test directly.
- Keep tests deterministic and hermetic: no network, external services, shared
  state, user configuration, ambient repository state, or uncontrolled time.
- For concurrency, prefer deterministic coordination or controlled scheduling over sleeps when practical.
- Test public behavior through public entry points. Test an internal helper only
  when it owns a stable rule.
- Prefer existing coverage at the behavior boundary. Do not add tests that
  merely mirror literals, mappings, obvious control flow, implementation
  details, or removed features unless absence is itself a product contract.
- Use fakes at owned boundaries; use subprocesses only for process or wire risk.
- Assert exact stable values. Partially match only deliberately dynamic fields;
  never snapshot a large whole object.

## Semantic Oracles

- Assert semantic outcomes, not source representation or implementation detail.
- Exact prompt, documentation, comment, source, or human-facing prose MUST NOT
  be an oracle unless those bytes are an explicit product contract.
- Use dedicated evaluations for Prompt behavior that cannot be verified
  hermetically; substring assertions do not prove Agent behavior.
- Negative source assertions belong only to a current closed set or safety
  boundary, never deleted history.

## Workflow

- Read the owning spec and identify the risk before changing production tests.
- Use repository scripts. Pass Vitest filters directly, without an intervening
  `--`; start narrow, then run checks proportional to the changed boundary.
- Greenfield tests cover the current contract, not compatibility or migration
  behavior unless explicitly requested.
- After material test changes, benchmark `pnpm test` against the <10s baseline;
  investigate regressions over 500ms and report the conclusion.
- Informative-asset-only changes run only relevant repository hygiene checks.
