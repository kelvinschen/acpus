/**
 * Glyphs and colors for acpus's true 6-state node lifecycle, plus kind labels
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

/** The unified 6 states. No "queued"/"needs-review"/"retried" — those are not acpus states. */
export const STATE_STYLES: Record<NodeState, StateStyle> = {
  pending: { glyph: "○", color: "gray", label: "Pending" },
  running: { glyph: "▶", color: "yellow", label: "Running" },
  completed: { glyph: "✓", color: "green", label: "Completed" },
  failed: { glyph: "✗", color: "red", label: "Failed" },
  paused: { glyph: "⏸", color: "cyan", label: "Paused" },
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
  approval: "APPROVAL",
  subworkflow: "SUBWORKFLOW"
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
