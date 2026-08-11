import type { ReactNode } from "react";
import type { WebGraph } from "../api.js";
import type { GraphNodeTarget } from "../graph/model.js";
import { InspectorPanel } from "./Inspector.js";
import { RunGraph } from "./RunGraph.js";
import { useInspectorPresence } from "./useInspectorPresence.js";

export type GraphInspectionTarget =
  | { kind: "workflow" }
  | { kind: "node"; node: GraphNodeTarget };

export type InspectorHeading = {
  title: string;
  eyebrow?: ReactNode;
  subtitle?: string;
  status?: ReactNode;
};

export function GraphWorkspace({
  graph,
  target,
  onTargetChange,
  heading,
  children,
}: {
  graph: WebGraph | undefined;
  target: GraphInspectionTarget | undefined;
  onTargetChange(target: GraphInspectionTarget | undefined): void;
  heading(target: GraphInspectionTarget): InspectorHeading;
  children(target: GraphInspectionTarget): ReactNode;
}) {
  const { exiting, close, layoutState } = useInspectorPresence(target, () => onTargetChange(undefined));
  const selectedRenderId = target?.kind === "node" ? target.node.renderId : undefined;
  const inspectorHeading = target ? heading(target) : undefined;

  return (
    <div className={`graph-inspection-layout ${layoutState === "open" ? "with-inspector" : layoutState === "closing" ? "closing-inspector" : ""}`}>
      <section className="graph-panel">
        <RunGraph
          graph={graph}
          {...(selectedRenderId === undefined ? {} : { selectedRenderId })}
          onSelectNode={node => onTargetChange(node ? { kind: "node", node } : undefined)}
          onSelectWorkflow={() => onTargetChange({ kind: "workflow" })}
        />
      </section>
      {target && inspectorHeading && (
        <div className="inspector-slot">
          <InspectorPanel {...inspectorHeading} exiting={exiting} onClose={close}>
            {children(target)}
          </InspectorPanel>
        </div>
      )}
    </div>
  );
}
