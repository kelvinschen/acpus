# Specification Maintenance Guide

This is the authority for Spec maintenance. Specs state current product
contracts, not plans, history, tutorials, tests, or implementation notes. Use
the template and catalog in [`specs/INDEX.md`](../specs/INDEX.md).

## Scope

- `specs/` owns stable behavior implemented by production code.
- `docs/roadmap/` owns future work; Git history and release tags own the past.
- Informative assets do not own product requirements. Follow
  [Skill Maintenance](skill-maintenance.md) for Skill content.
- Observable is not enough: specify only stable, material behavior owned by
  production code.

## Change Rules

- **New capability:** add its smallest stable contract to the existing owner.
- **Changed capability:** replace or consolidate superseded requirements.
- **Removed capability:** delete obsolete requirements; leave no tombstones.
- **Behavior-preserving refactor:** add no requirement; update only stale
  ownership, links, or verification routing.
- Create a new spec only for a distinct stable boundary with a clear owner and
  independent verification.

## Writing Rules

- State observable outcomes, public interfaces, invariants, and decision
  boundaries; omit algorithms, internal structure, examples, and test matrices.
- Keep each contract canonical in one owner spec. Other specs link to it and
  describe only their own boundary.
- Select material contracts before making requirements atomic. Atomic does not
  mean exhaustive.
- Use RFC 2119/8174 terms deliberately. Negative requirements belong only to a
  current closed shape, safety boundary, or unsupported input.
- Treat current development as greenfield; specify compatibility only when
  explicitly requested as current behavior.

## Verification

- Update the owner spec and focused verification together only when the current
  product contract changes.
- Name the narrow command and contract risk; follow
  [Testing Maintenance](testing-maintenance.md) for test design.
- Before handoff, confirm one owner, current-only wording, focused verification,
  and no avoidable net growth.
