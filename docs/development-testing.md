# Development and Testing Guide

This guide describes the testing philosophy for changing the TypeScript Acpus codebase. Product behavior belongs in `specs/`; tests provide focused evidence that the specified behavior remains true.

## Principles

- Start from a concrete risk. Every test should make clear what regression it would catch.
- Test at the lowest stable boundary that can prove the behavior.
- Prefer deterministic, hermetic tests over realistic but uncontrollable environments.
- Assert stable outcomes, not incidental implementation details.
- Keep setup smaller than the behavior being tested.
- Make test cost proportional to risk. Filesystem, subprocess, and end-to-end tests must justify their additional time and failure surface.
- Treat the test suite as maintained product code: readable, fast, and easy to diagnose.

Tests are not a substitute for design. If behavior is difficult to test without broad setup or extensive mocking, first consider whether the production boundary is too shallow or responsibilities are mixed.

## Choose the Smallest Useful Layer

| Layer | Question it should answer |
| --- | --- |
| Unit | Does one rule, transformation, or state transition behave correctly? |
| Type contract | Does the public TypeScript contract accept and reject the intended programs? |
| Contract | Does a public API, diagnostic, serialized shape, or protocol remain stable? |
| Integration | Do multiple owned components cooperate correctly across a meaningful boundary? |
| End-to-end | Can a user complete a high-value workflow through the real product surface? |
| Regression | Does the smallest reproduction of a previously fixed defect stay fixed? |

Use a higher layer only when a lower layer cannot observe the risk. Do not repeat the same assertion at every layer: lower tests should explain detailed rules, while higher tests should prove that the seams are connected.

## Design Tests Around Behavior

Give each test one dominant reason to fail. Its name, setup, and assertion should reveal that reason without requiring the reader to reconstruct the implementation.

Prefer exact assertions for stable values such as tagged failures, diagnostics, exit codes, normalized data, and public protocol fields. Use partial matching only for deliberately dynamic data such as generated ids, timestamps, source text, and temporary paths.

Avoid whole-object snapshots for large IR, projections, or runtime documents. Assert the smallest stable slice that expresses the contract. A broad snapshot often turns unrelated refactors into noisy test changes and can hide the behavior that actually matters.

Keep tests hermetic:

- Do not depend on network services, user configuration, shared state, or ambient repository state.
- Isolate filesystem state and always clean it up.
- Control time explicitly; do not wait for real polling intervals.
- Use real subprocesses only when process isolation, lifecycle, or wire behavior is the subject of the test.
- Use fakes at owned boundaries, not to reproduce the internals of the component under test.

Test public behavior through public entrypoints. Testing an internal helper is appropriate when the helper itself owns a stable rule; it should not be used merely to bypass the public contract.

## Change Workflow

1. Read the owning spec and identify the behavior and failure modes affected by the change.
2. Change the smallest production layer that owns the behavior.
3. Add or update the smallest test that would have caught the defect or design gap.
4. Run narrow checks while iterating, then broaden verification in proportion to the change's reach and risk.
5. Update the canonical spec in the same change when current behavior changes.

Greenfield changes should test the current contract directly. Do not add compatibility tests, migration behavior, or legacy terminology unless they are explicitly part of the requested behavior. `legacy/` remains read-only history.

Use the repository's package scripts rather than duplicating their underlying commands. A typical progression is a focused test project or file, then package typechecking, followed by workspace tests and build checks when the change crosses package or distribution boundaries.

Documentation-only changes may skip executable checks when they cannot affect behavior. State that decision explicitly. When generated artifacts are checked in, regenerate them through their owning script rather than editing them manually.

## Handoff Standard

Before handing off a change, confirm that:

- the spec and implementation describe the same current behavior;
- each test protects an identifiable risk at the lowest useful layer;
- assertions target stable contracts and produce a clear failure signal;
- expensive tests cover high-value seams rather than duplicating cheaper tests;
- tests are deterministic and leave no external state behind;
- relevant tests, typechecks, and build checks were run, with any omissions stated clearly.
