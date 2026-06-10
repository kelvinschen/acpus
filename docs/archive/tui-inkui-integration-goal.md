# TUI InkUI Integration Goal

Archived completion record. The Ink/React upgrade and selected InkUI-inspired
TUI components have been implemented in `packages/tui`; current behavior is
specified in `specs/cli-spec.md`. This document is retained only as the
historical execution goal and review plan.

## Purpose

This roadmap document defines a staged execution goal for improving the Acpus
single-Run TUI by trying selected InkUI components in the existing Ink/React
visualizer.

The intended executor is a follow-up agent. Treat this as a delivery plan, not
current implementation truth. Current behavior remains specified in `specs/`.

## Target Components

Use or adapt these InkUI components:

- `@inkui-cli/scroll-area`: improve graph/details scrolling and remove the
  current poor manual scroll feel.
- `@inkui-cli/key-hint`: replace hand-written footer hint strings with grouped
  key hints.
- `@inkui-cli/tabs`: split Node Details into focused sections instead of one
  long coupled page.
- `@inkui-cli/markdown`: render Agent Step prompts more readably.
- `@inkui-cli/json-viewer`: render structured Node output more readably.
- `@inkui-cli/spinner`: make currently running state visually clearer.

The project accepts upgrading `ink` and `react` for this work.

## Known Starting Point

- `@acpus/tui` currently uses `ink ^5.1.0`, `react ^18.3.1`, and
  `@types/react ^18.3.12` in `packages/tui/package.json`.
- InkUI component packages currently target `ink ^6` / `react ^19`.
- Observed package versions during planning:
  - `@inkui-cli/scroll-area@0.2.0`
  - `@inkui-cli/key-hint@0.1.1`
  - `@inkui-cli/tabs@0.2.0`
  - `@inkui-cli/markdown@0.2.0`
  - `@inkui-cli/json-viewer@0.2.0`
  - `@inkui-cli/spinner@0.1.0`
  - `@inkui-cli/core@0.1.0`
- The current npm registry in this workspace may not mirror every
  `@inkui-cli/*` package. If direct package install fails, use the InkUI
  copy-paste component model and vendor only the selected component sources
  under `packages/tui/src/ui/inkui/`, with a small local theme/core adapter.

## Execution Constraints

- Keep `@acpus/core` free of UI concerns. All work belongs in `packages/tui`
  unless CLI behavior or tests require a small integration update.
- Treat the TUI behavior as greenfield current behavior. Do not add Ink 5 /
  React 18 compatibility shims.
- Preserve Acpus semantics from `specs/cli-spec.md`: single-Run visualizer,
  Run picker, graph/details focus, Run controls, Node retry, approval signals,
  OSC 52 details copy, artifact path rendering, and Agent Step transcript
  telemetry.
- If keybindings or displayed behavior change, update `specs/cli-spec.md` in
  the same implementation phase.
- After each feature phase, run the relevant tests and the package build. At
  minimum use `pnpm --filter @acpus/tui typecheck`, relevant TUI tests, and
  `pnpm --filter @acpus/tui build`; run broader `pnpm test` or `pnpm build`
  when shared behavior is touched.
- Preserve or improve wrapping guarantees for long Node Keys, prompts, errors,
  artifact paths, and JSON output.

## Review Gate For Every Phase

Each phase has a review gate before it is considered done.

1. Finish the phase implementation and local tests.
2. Create a synthetic implementation commit from the current working tree using
   `git commit-tree`. Do not advance the branch just to make review possible.
3. Run `workflows/adversarial-feature-implementation-review.workflow.spec.yaml`
   with the synthetic commit as `implementation_ref`.
4. Triage the review report. Fix confirmed real bugs, especially blocking,
   high, correctness, contract, and test findings.
5. If fixes materially change code, create a fresh synthetic commit and rerun
   the review gate until remaining findings are either fixed or explicitly
   documented as non-bugs / follow-up work.

Recommended shell snippet from repository root:

```bash
phase_name="inkui-tui-phase-1"
base_ref="$(git rev-parse HEAD)"
tmp_index="$(mktemp)"
rm -f "$tmp_index"
trap 'rm -f "$tmp_index"' EXIT

GIT_INDEX_FILE="$tmp_index" git read-tree "$base_ref"
GIT_INDEX_FILE="$tmp_index" git add -A -- .
implementation_ref="$(
  GIT_INDEX_FILE="$tmp_index" git commit-tree \
    "$(GIT_INDEX_FILE="$tmp_index" git write-tree)" \
    -p "$base_ref" \
    -m "review: ${phase_name}"
)"

export FEATURE_GOAL="Integrate selected InkUI components into the Acpus single-Run TUI ${phase_name}."
export REVIEW_OUTPUT_DIR="docs/archive/adversarial-reviews/${phase_name}"
export BASE_REF="$base_ref"
export IMPLEMENTATION_REF="$implementation_ref"

pnpm build
pnpm acpus run workflows/adversarial-feature-implementation-review.workflow.spec.yaml \
  --input "$(
    node -e '
      const input = {
        target_path: process.cwd(),
        feature_goal: process.env.FEATURE_GOAL,
        output_dir: process.env.REVIEW_OUTPUT_DIR,
        base_ref: process.env.BASE_REF,
        implementation_ref: process.env.IMPLEMENTATION_REF,
        review_depth: "deep",
        review_instructions: [
          "Focus on TUI behavior, Ink/React upgrade risk, keyboard conflicts, terminal sizing, scroll bounds, and spec drift.",
          "Treat docs/archive review artifacts as validation records, not current design truth."
        ].join("\n")
      };
      process.stdout.write(JSON.stringify(input));
    '
  )"
```

Store review outputs under `docs/archive/adversarial-reviews/`. Keep the final
cross-examination report and any fix notes that explain what was changed.

## Phase 1: Ink/React Upgrade And Integration Strategy

Goal: make `@acpus/tui` compatible with InkUI's runtime baseline.

Tasks:

- Upgrade `ink`, `react`, and `@types/react` in the TUI package.
- Decide whether to use direct `@inkui-cli/*` packages or copy selected
  component sources locally. Prefer direct packages if registry resolution is
  reliable; otherwise vendor only selected components.
- Add a local Acpus theme adapter so InkUI colors align with
  `packages/tui/src/theme.ts` and use single-column glyphs where alignment
  matters.
- Run existing TUI tests and fix Ink 6 / React 19 type or rendering breaks.

Acceptance:

- Existing TUI tests pass without weakening assertions.
- `packages/tui` builds and typechecks.
- No user-visible behavior changes except those forced by the dependency
  upgrade.
- Review gate has run and confirmed bugs from the upgrade are fixed.

## Phase 2: ScrollArea, KeyHint, And Spinner

Goal: improve interaction feel without changing the information architecture.

Tasks:

- Replace manual details window rendering with a ScrollArea-backed component
  or an adapted local ScrollArea that accepts controlled `scrollOffset`.
- Preserve details `j`/`k` line scroll, `u`/`d` half-page scroll, `y` copy, and
  graph/details focus switching.
- Evaluate whether GraphPane should also use ScrollArea or keep the current
  selected-row window logic. Avoid regressions in selected-row centering,
  `g`/`G`, and collapse filtering.
- Replace `Footer` string composition with `KeyHint` groups.
- Add `Spinner` only for active running states, for example top bar live status
  or selected running Node context. Avoid adding timers to non-live terminal
  states.

Acceptance:

- Scroll never exceeds content bounds for empty, short, exact-height, and long
  Details content.
- Footer hints remain compact at narrow widths and do not wrap into incoherent
  overlapping output.
- Running indicator stops animating when the Run is terminal.
- Existing copy-to-clipboard plain text behavior remains independent of the
  visible scroll window.
- Review gate has run and confirmed bugs are fixed.

## Phase 3: Tabs For Node Details

Goal: split Node Details into task-focused sections so users do not scan one
long page.

Candidate tabs:

- `Summary`: Node, Kind, Status, Attempt, Duration, Key, branch/lane/round/item
  context.
- `Definition`: Agent / Program / Composite definition metadata.
- `Execution`: Agent transcript telemetry, token counts, and recent tool calls.
- `Prompt`: rendered prompt or template fallback.
- `Output`: JSON output or primitive output.
- `Artifacts`: artifact filenames and absolute paths.
- `Error`: visible only when there is a non-hidden error.

Tasks:

- Refactor `buildDetailLines` into section builders while preserving the
  existing plain-text copy path.
- Integrate Tabs without letting its default `h`/`l` handling steal global
  graph/details focus unless the spec is intentionally changed.
- Add tab navigation that is discoverable in `KeyHint`; numeric tab shortcuts
  are acceptable if they do not conflict with existing controls.
- Reset or clamp per-tab scroll when the selected Node or active tab changes.

Acceptance:

- The selected Node's details remain complete across tabs.
- `y` copies either the full selected Node details or the active tab according
  to the spec update made in this phase; tests capture the chosen behavior.
- Awaiting approval hints, Run controls, retry behavior, and focus switching
  continue to work.
- Review gate has run and confirmed bugs are fixed.

## Phase 4: Markdown Prompts And JSON Output

Goal: render high-information fields with structure while keeping terminal
layout predictable.

Tasks:

- Use InkUI Markdown for prompt display in the `Prompt` tab.
- Use InkUI JSONViewer for object/array output in the `Output` tab.
- Keep fallback plain rendering for non-object output and invalid/unexpected
  data.
- Gate JSONViewer keyboard input so it is active only when the Output tab is
  focused; avoid `h`/`l` conflicts with global focus unless explicitly
  reworked.
- Wrap or truncate Markdown and JSON lines within the Details pane width budget.

Acceptance:

- Long prompts no longer degrade into an unreadable wall of text.
- Structured JSON output is navigable and does not break height accounting.
- Plain-text details copy still contains useful prompt/output content without
  terminal styling artifacts.
- Tests cover Markdown prompt rendering and JSON output rendering, including
  empty output, primitive output, nested object output, and long strings.
- Review gate has run and confirmed bugs are fixed.

## Phase 5: Full TUI Pass And Spec Alignment

Goal: make the integrated experience coherent and lock down the new current
behavior.

Tasks:

- Run the visualizer through representative Run states: loading, running,
  awaiting approval, failed Node, retried Run, completed Run, and cancelled or
  paused Run.
- Re-check terminal dimensions: narrow terminal, short terminal, and standard
  120x40 terminal.
- Update `specs/cli-spec.md` for final current behavior if tabs, keybindings,
  prompts, JSON output, or spinner behavior changed.
- Add or update tests listed under the CLI spec's TUI verification section.
- Run full build after implementation completion so generated artifacts are
  current.

Acceptance:

- `pnpm test`, `pnpm typecheck`, and `pnpm build` pass unless an unrelated
  pre-existing failure is documented with evidence.
- `specs/cli-spec.md` describes only the new current behavior and does not keep
  legacy wording solely to describe removed behavior.
- Review gate has run and confirmed bugs are fixed.

## Suggested Skills For Follow-Up Agent

- `diagnose`: use if Ink 6 / React 19 introduces failing TUI tests or runtime
  rendering regressions.
- `tdd`: use for the scroll, tab, Markdown, and JSONViewer behavioral changes
  because they have clear regression surfaces.
- `browser:control-in-app-browser` is not relevant unless the follow-up agent
  creates a web preview; this is an Ink terminal UI task.

## Completion Definition

The overall goal is complete when the TUI uses or locally adapts the selected
InkUI components, all staged review gates have run, confirmed real bugs from
those reviews are fixed, specs reflect the new current behavior, and the
project build/test commands pass or have documented unrelated failures.
