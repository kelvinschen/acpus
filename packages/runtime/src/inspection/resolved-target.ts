import type {
  ArtifactRecord,
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicNodeInstance,
  RunDynamicSignalWait,
  RunExecutionMetadata,
  RunNodeProgress,
} from "../store/store.js";
import type {
  RunInspectionControl,
  RunInspectionItem,
  RunInspectionRunSummary,
  RunInspectionStaticNode,
  RunInspectionTarget,
  RunInspectionTargetSummary,
} from "./types.js";

/**
 * Private resolved state shared by the narrow inspection projections. This is
 * never a Runtime root export or a CLI/Web response.
 */
export type ResolvedTargetState = {
  run: RunInspectionRunSummary;
  target: RunInspectionTarget;
  staticNode?: RunInspectionStaticNode;
  summary: RunInspectionTargetSummary;
  items: RunInspectionItem[];
  instances: RunDynamicNodeInstance[];
  frames: RunDynamicFrame[];
  attempts: RunDynamicAttempt[];
  signalWaits: RunDynamicSignalWait[];
  executionMetadata: RunExecutionMetadata[];
  progress: RunNodeProgress[];
  artifacts: ArtifactRecord[];
  availableControls: RunInspectionControl[];
};
