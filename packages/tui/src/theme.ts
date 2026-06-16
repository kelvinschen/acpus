/**
 * Glyphs and colors for acpus's true 7-state node lifecycle, plus kind labels
 * for composite/executable nodes. Deliberately mirrors acpus semantics — NOT
 * the reference image's invented states (queued / needs-review / retried).
 */

import type { NodeState } from "@acpus/runtime";
import type { IrNodeKind } from "@acpus/core";

export interface StateStyle {
  glyph: string;
  color: string;
  label: string;
}

/**
 * The unified 7 states. No "queued"/"needs-review"/"retried" — those are not
 * acpus states.
 *
 * IMPORTANT: every glyph MUST be a single terminal column wide. Wide (emoji /
 * East-Asian) glyphs like ⏳/⏸/▶ render as 2 columns and break the
 * `justifyContent="space-between"` alignment in StatusOverview (and skew the
 * graph tree indentation). Use single-width symbols only.
 */
export const STATE_STYLES: Record<NodeState, StateStyle> = {
  pending: { glyph: "○", color: "gray", label: "Pending" },
  running: { glyph: "▷", color: "yellow", label: "Running" },
  awaiting: { glyph: "◷", color: "blue", label: "Awaiting" },
  completed: { glyph: "✓", color: "green", label: "Completed" },
  failed: { glyph: "✗", color: "red", label: "Failed" },
  paused: { glyph: "=", color: "cyan", label: "Paused" },
  cancelled: { glyph: "⊘", color: "magenta", label: "Cancelled" }
};

/** Short uppercase label for a composite container header. */
export const KIND_LABELS: Record<IrNodeKind, string> = {
  pipeline: "PIPELINE",
  "run.agent": "AGENT",
  "run.program": "PROGRAM",
  parallel: "PARALLEL",
  fanout: "FANOUT",
  switch: "SWITCH",
  loop: "LOOP",
  guard: "GUARD",
  "run.signal": "SIGNAL",
  subworkflow: "SUBWORKFLOW"
};

export interface KindStyle {
  symbol: string;
  color: string;
  label: string;
}

/** Single-width node-kind symbols and colors shared by graph rows and legends. */
export const KIND_STYLES: Record<IrNodeKind, KindStyle> = {
  pipeline: { symbol: "▣", color: "green", label: "Pipeline" },
  "run.agent": { symbol: "✦", color: "cyan", label: "Agent" },
  "run.program": { symbol: "$", color: "yellow", label: "Program" },
  parallel: { symbol: "▥", color: "blueBright", label: "Parallel" },
  fanout: { symbol: "◬", color: "magenta", label: "Fanout" },
  switch: { symbol: "◇", color: "blue", label: "Switch" },
  loop: { symbol: "↻", color: "yellowBright", label: "Loop" },
  guard: { symbol: "◈", color: "redBright", label: "Guard" },
  "run.signal": { symbol: "◌", color: "white", label: "Signal" },
  subworkflow: { symbol: "▧", color: "gray", label: "Subworkflow" }
};

/** Composite kinds control other nodes; the rest are executable leaves. */
export const COMPOSITE_KINDS: ReadonlySet<IrNodeKind> = new Set<IrNodeKind>([
  "pipeline",
  "parallel",
  "fanout",
  "switch",
  "loop",
  "subworkflow"
]);

export function isComposite(kind: IrNodeKind): boolean {
  return COMPOSITE_KINDS.has(kind);
}

export function styleForState(state: NodeState | undefined): StateStyle {
  return state ? STATE_STYLES[state] : { glyph: "·", color: "gray", label: "Not started" };
}

export function styleForKind(kind: IrNodeKind): KindStyle {
  return KIND_STYLES[kind];
}
