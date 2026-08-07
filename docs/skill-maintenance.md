# Skill Maintenance Guide

This is the authority for `packages/cli/skills/**` and Skill-facing guidance,
including `SKILL.md`, references, prompts, READMEs, examples, and bundled
workflows.

## Role and Ownership

- Skill content is an informative asset, even when shipped or executable. It
  does not own product requirements or product tests.
- `SKILL.md` is a compact router. A focused reference owns topic guidance; a
  workflow README owns that workflow's usage; examples only illustrate.
- Keep each instruction canonical in one file and link to it instead of
  repeating it across entry points, references, READMEs, and examples.
- Describe the user's next valid action, not implementation detail, Spec text,
  history, or test inventories.

## Change Rules

- **Changed capability:** rewrite existing guidance in place, delete superseded
  wording, and keep the affected guidance the same size or smaller.
- **Behavior-preserving refactor:** change no guidance unless the user's workflow
  changes.
- **New capability:** add at most one `SKILL.md` routing bullet and 120 net-new
  words across affected guidance, including examples and commands, unless
  explicitly approved.
- Prefer one short task-oriented section or link over extra examples and
  branch-by-branch explanation.

## Product Boundary

- Do not add or change a product Spec or product-behavior test for real Skill
  wording, inventory, layout, compilation, Prompt behavior, or example output.
- Product code that packages, installs, reads, or accepts Skill assets remains
  in scope. Follow [Specification Maintenance](specification-maintenance.md) and
  [Testing Maintenance](testing-maintenance.md), using synthetic fixtures.

## Verification

- Review routing, links, current commands, and the user's next executable action.
- Run relevant documentation or repository hygiene checks; do not treat them as
  product-behavior evidence.
- Before handoff, confirm one content owner, no superseded wording, and compliance
  with the new-capability text budget.
