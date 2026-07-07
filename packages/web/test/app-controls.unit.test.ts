import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandForControl, confirmationForControl, controlStateForRun, retryCommandTarget, retryTargetsForRun, runHeaderViewState } from "../src/client/ui/App.js";
import type { RunDetails } from "../src/client/api.js";

describe("runtime run controls", () => {
  it("shows pause and cancel for active runs", () => {
    expect(controlStateForRun("running", false).map(control => control.id)).toEqual(["pause", "cancel"]);
    expect(controlStateForRun("running", false).every(control => !control.disabled)).toBe(true);
  });

  it("shows resume and cancel for paused runs", () => {
    expect(controlStateForRun("paused", false).map(control => control.id)).toEqual(["resume", "cancel"]);
  });

  it("shows target-first retry only for failed runs", () => {
    const controls = controlStateForRun("failed", false, [{ value: "node_a~123", label: "node: a", kind: "node" }]);
    expect(controls.map(control => control.id)).toEqual(["retry"]);
    expect(controls[0]!.disabled).toBe(false);
  });

  it("disables retry when no failed target exists", () => {
    const controls = controlStateForRun("failed", false, []);
    expect(controls).toMatchObject([{ id: "retry", disabled: true }]);
  });

  it("disables terminal run controls", () => {
    for (const status of ["completed", "canceled"]) {
      const controls = controlStateForRun(status, false);
      expect(controls.map(control => control.id)).toEqual(["pause", "cancel"]);
      expect(controls.every(control => control.disabled)).toBe(true);
    }
  });

  it("extracts failed retry targets from frames, node instances, and group members", () => {
    const targets = retryTargetsForRun({
      dynamic: {
        version: 1,
        attempts: [],
        signalWaits: [],
        executionMetadata: [],
        frames: [
          { frameKey: "z_frame", nodeId: "route", frameKind: "node", status: "failed" },
          { frameKey: "ignored_scope", nodeId: "scope", frameKind: "scope", status: "failed" },
        ],
        nodeInstances: [
          { nodeKey: "a_node", nodeId: "score_gate", status: "failed" },
          { nodeKey: "done_node", nodeId: "done", status: "completed" },
        ],
        groupMembers: [
          { memberKey: "m_member", branchId: "cache", status: "failed" },
          { memberKey: "a_node", branchId: "duplicate", status: "failed" },
        ],
      },
    } satisfies Pick<RunDetails, "dynamic">);

    expect(targets).toEqual([
      { value: "a_node", label: "node: score_gate", kind: "node" },
      { value: "m_member", label: "member: cache", kind: "member" },
      { value: "z_frame", label: "frame: route", kind: "frame" },
    ]);
  });

  it("uses the only failed target directly and respects selected target for multiples", () => {
    const one = [{ value: "node_a", label: "node: a", kind: "node" as const }];
    const many = [...one, { value: "node_b", label: "node: b", kind: "node" as const }];

    expect(retryCommandTarget(one, undefined)).toBe("node_a");
    expect(retryCommandTarget(many, "node_b")).toBe("node_b");
    expect(retryCommandTarget(many, "missing")).toBeUndefined();
  });

  it("builds command payloads only after a confirmable target exists", () => {
    expect(commandForControl("pause", undefined, undefined)).toEqual({ type: "pause" });
    expect(commandForControl("resume", undefined, undefined)).toEqual({ type: "resume" });
    expect(commandForControl("cancel", undefined, "node_a")).toEqual({ type: "cancel", target: "node_a" });
    expect(commandForControl("cancel", undefined, undefined)).toEqual({ type: "cancel" });
    expect(commandForControl("retry", "node_a", undefined)).toEqual({ type: "retry", target: "node_a" });
    expect(commandForControl("retry", undefined, undefined)).toBeUndefined();
  });

  it("describes destructive and recovery controls before submission", () => {
    expect(confirmationForControl("cancel", "node_a")).toMatchObject({
      title: "Cancel selected target?",
      confirmLabel: "Cancel",
      tone: "cancel",
    });
    expect(confirmationForControl("retry", "node: score_gate")).toMatchObject({
      title: "Retry failed target?",
      confirmLabel: "Retry",
      tone: "retry",
    });
    expect(confirmationForControl("pause", undefined).title).toBe("Pause this run?");
    expect(confirmationForControl("resume", undefined).title).toBe("Resume this run?");
  });
});

describe("runtime header and control styles", () => {
  const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/client/ui/App.tsx", import.meta.url), "utf8");
  const toastSource = readFileSync(new URL("../src/client/ui/Toast.tsx", import.meta.url), "utf8");

  it("uses a compact sans-serif workflow title", () => {
    expect(styles).toContain(".topbar h2");
    expect(styles).toContain("font-family: var(--font-sans)");
  });

  it("uses a structured runtime header skeleton while run details load", () => {
    const loading = runHeaderViewState(undefined, undefined);
    const error = runHeaderViewState(undefined, new Error("Run not found"));
    const readyRun = { id: "run-1", name: "workflow", status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z", input: {}, dynamic: { version: 1 } } as RunDetails;
    expect(loading).toEqual({ kind: "loading" });
    expect(error).toEqual({ kind: "error", message: "Run not found" });
    expect(runHeaderViewState(readyRun, new Error("ignored"))).toEqual({ kind: "ready", run: readyRun });
    expect(appSource).toContain("function RunHeaderSkeleton");
    expect(appSource).toContain("function RunHeaderError");
    expect(appSource).toContain('aria-label="Loading run details"');
    expect(appSource).toContain('role="alert"');
    expect(appSource).toContain('className="run-header-skeleton"');
    expect(styles).toContain(".run-header-skeleton");
    expect(styles).toContain(".run-header-error");
    expect(styles).toContain(".run-header-skeleton .state-skeleton-line.title");
    expect(styles).toContain(".run-header-skeleton .state-skeleton-line.meta");
  });

  it("uses product sans typography for page and panel headings", () => {
    const headingStyles = [
      styles.slice(styles.indexOf(".page-header h2 {"), styles.indexOf(".search-input {")),
      styles.slice(styles.indexOf(".inspector-section-head h3 {"), styles.indexOf(".inspector-section-body {")),
      styles.slice(styles.indexOf(".empty-state h2 {"), styles.indexOf(".empty-state p {")),
      styles.slice(styles.indexOf(".status-info-title {"), styles.indexOf(".status-info-rows {")),
    ].join("\n");
    expect(headingStyles).toContain("font-family: var(--font-sans)");
    expect(appSource).toContain("page-header-detail");
  });

  it("defines action-specific control variants", () => {
    expect(styles).toContain(".icon-button.pause");
    expect(styles).toContain(".icon-button.resume");
    expect(styles).toContain(".icon-button.retry");
    expect(styles).toContain(".icon-button.cancel");
    expect(styles).toContain(".retry-target-select");
    expect(appSource).toContain('aria-label="Retry target"');
    expect(styles).toContain(".confirm-dialog");
    expect(styles).toContain(".confirm-primary.cancel");
  });

  it("keeps runtime status in the fixed sidebar footer", () => {
    expect(appSource).toContain("<SidebarStatus");
    expect(appSource).toContain("type SidebarStatusProps = React.ButtonHTMLAttributes<HTMLButtonElement>");
    expect(appSource).toContain("const SidebarStatus = React.forwardRef<HTMLButtonElement, SidebarStatusProps>");
    expect(appSource).toContain('title="Runtime status" {...props}');
    expect(appSource).toContain('ref={ref}');
    expect(appSource).toContain('SidebarStatus.displayName = "SidebarStatus"');
    expect(appSource).toContain("<Popover open={statusOpen} onOpenChange={setStatusOpen}>");
    expect(appSource).toContain("<PopoverTrigger asChild>");
    expect(appSource).toContain("status-info-popover");
    expect(appSource).toContain("status-health-summary");
    expect(appSource).toContain('<h2 id="status-info-title">Runtime status</h2>');
    expect(styles).toContain(".sidebar-status");
    expect(styles).toContain(".status-info-popover");
    expect(styles).toContain("transform-origin: left top");
    expect(appSource).toContain("function sidebarStatusIcon");
    expect(appSource).toContain("sidebar-status-icon");
    expect(appSource).toContain('status === "fail" || status === "error"');
    expect(styles).toContain(".sidebar-status-icon.checking");
    expect(styles).toContain(".sidebar-status-icon.fail");
    expect(styles).toContain(".status-info-rows");
    expect(styles).toContain(".status-health-summary");
    expect(styles).toContain(".dialog-head h2");
    expect(styles).toContain("height: 100vh");
    expect(styles).toContain("overflow: hidden");
  });

  it("keeps run status living feedback to one icon without right-side bars", () => {
    const indicatorSource = appSource.slice(
      appSource.indexOf("function RunStatusIndicator"),
      appSource.indexOf("function isTerminalRunStatus"),
    );
    const indicatorStyle = styles.slice(
      styles.indexOf(".run-status-indicator {"),
      styles.indexOf(".run-status-indicator.queued"),
    );
    const iconStyle = styles.slice(
      styles.indexOf(".run-status-icon {"),
      styles.indexOf(".run-status-indicator.live"),
    );
    expect(indicatorSource).toContain("run-status-icon");
    expect(indicatorStyle).toContain("background: transparent");
    expect(iconStyle).toContain("width:");
  });

  it("labels runtime projection version explicitly", () => {
    expect(appSource).toContain('label="Runtime version"');
  });

  it("uses a docked graph inspector card with conditional tabs", () => {
    expect(appSource).toContain("function InspectorPanel");
    expect(appSource).toContain("graph-inspection-layout");
    expect(appSource).toContain("GraphInspectionTarget");
    expect(appSource).toContain("RuntimeWorkflowInspector");
    expect(appSource).toContain("StaticWorkflowInspector");
    const inspectorStart = appSource.indexOf("function Inspector(");
    const runtimeHeadSource = appSource.slice(
      appSource.indexOf('<div className="inspector-runtime-head">', inspectorStart),
      appSource.indexOf('<Tabs value={activeTab}', inspectorStart),
    );
    expect(runtimeHeadSource).toContain("<span>Start</span>");
    expect(runtimeHeadSource).toContain("formatDate(summary.runStartedAt)");
    expect(runtimeHeadSource).toContain("<span>Duration</span>");
    expect(runtimeHeadSource).toContain("formatDuration(summary.runDurationMs)");
    expect(appSource).toContain("displayStatus?: DisplayStatus");
    expect(appSource).toContain("const runtimeStatus = displayStatus ?? normalizeRuntimeStatus(summary.nodeStatus ?? summary.runStatus)");
    expect(appSource).toContain("<StatusPill status={runtimeStatus} />");
    expect(appSource).toContain('<KeyValue label="Runtime" value={runtimeStatus} />');
    expect(appSource).toContain("window.matchMedia(reducedMotionQuery).matches");
    expect(appSource).toContain("function InspectorTab");
    expect(appSource).toContain("function InspectorTabPanel");
    expect(appSource).toContain("<Tabs value={activeTab}");
    expect(appSource).toContain("<TabsList className=\"inspector-tabs\"");
    expect(appSource).toContain("<TabsTrigger");
    expect(appSource).toContain("<TabsContent");
    expect(appSource).toContain("aria-labelledby={`inspector-tab-${id}`}");
    expect(appSource).toContain('{hasArtifacts && (');
    expect(appSource).toContain('{hasExecution && (');
    expect(appSource).toContain("AgentExecutionTab");
    expect(appSource).toContain("JsonView");
    expect(appSource).toContain("ReactMarkdown");
    expect(appSource).toContain("function TextArtifactPreview");
    expect(appSource).toContain("function tryParseJsonPreview");
    expect(appSource).toContain("value.ok ? (");
    expect(appSource).toContain('<TextArtifactPreview value={loaded.text} label="Raw JSON text" />');
    expect(appSource).toContain('className="artifact-title mono" title={artifact.relativePath}');
    expect(appSource).toContain('aria-label={`Artifact ${artifact.relativePath}`}');
    expect(appSource).toContain('<pre className="text-artifact-preview">{value}</pre>');
    expect(appSource).toContain("function JsonSection");
    expect(appSource).toContain("function JsonCopyButton");
    expect(appSource).toContain("action={<JsonCopyButton value={value} />}");
    expect(appSource).toContain("navigator.clipboard.writeText(JSON.stringify(value, null, 2))");
    expect(appSource).toContain("Copy JSON");
    expect(styles).toContain(".inspector-card");
    expect(styles).toContain(".inspector-tab-panel");
    expect(styles).toContain(".inspector-tab-panel[hidden]");
    expect(styles).toContain(".inspector-tab:focus-visible");
    expect(styles).toContain("outline-offset: -2px");
    expect(styles).toContain("minmax(340px, 428px)");
    expect(styles).toContain(".graph-inspection-layout.closing-inspector");
    expect(styles).toContain(".inspector-slot");
    expect(styles).toContain(".inspector-card.exiting");
    expect(styles).toContain(".select-content");
    expect(styles).toContain("@keyframes inspector-card-out");
    expect(styles).toContain("transition: grid-template-columns 220ms var(--ease-out-strong), grid-template-rows 220ms var(--ease-out-strong), gap 220ms var(--ease-out-strong)");
    expect(styles).toContain(".graph-flow-shell.viewport-animating .graph-canvas");
    const viewportBoxTransition = styles.slice(
      styles.indexOf(".graph-flow-shell.viewport-animating .graph-box"),
      styles.indexOf(".graph-toolbar {"),
    );
    expect(viewportBoxTransition).toContain("border-color");
    expect(viewportBoxTransition).toContain("box-shadow");
    expect(styles).toContain(".inspector-tabs");
    expect(styles).toContain(".inspector-section");
    expect(styles).toContain(".inspector-section-head");
    expect(styles).toContain("justify-content: space-between");
    expect(styles).toContain("border-top: 1px solid var(--ui-border)");
    expect(styles).toContain(".json-viewer");
    expect(styles).toContain(".json-copy-button");
    expect(styles).toContain(".json-standalone");
    expect(styles).toContain(".artifact-title");
    expect(styles).toContain(".text-artifact-shell");
    expect(styles).toContain("max-width: 100%");
    expect(styles).toContain("white-space: pre-wrap");
    expect(styles).toContain("word-break: break-word");
    expect(styles).toContain(".json-viewer ._2IvMF");
    expect(styles).toContain(".markdown-viewer");
    expect(styles).toContain(".text-artifact-preview");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(appSource).toContain('className="key-value" tabIndex={0}');
    expect(appSource).toContain('title={`${label}: ${value}`}');
    const keyValueStyle = styles.slice(styles.indexOf(".key-value {"), styles.indexOf(".key-value span"));
    expect(keyValueStyle).toContain("display: flex");
    expect(keyValueStyle).toContain("justify-content: space-between");
    expect(appSource).toContain("Context Window");
    expect(appSource).toContain("Token Usage");
    expect(appSource).toContain("Last Tool Calls");
    expect(styles).toContain(".execution-meter");
    expect(styles).toContain(".execution-metrics");
    expect(styles).toContain(".tool-call-row");
    expect(styles).toContain(".tool-call-status");
    expect(styles).toContain(".graph-inspection-layout.closing-inspector");
    expect(styles).toContain("grid-template-rows: minmax(320px, 1fr) 0");
  });

  it("exposes workflow-level input and output through the graph inspector", () => {
    const graphSource = readFileSync(new URL("../src/client/ui/RunGraph.tsx", import.meta.url), "utf8");
    expect(graphSource).toContain("onSelectWorkflow");
    expect(graphSource).toContain("Workflow I/O");
    expect(graphSource).toContain("Braces");
    expect(styles).toContain(".graph-tool-button.workflow-io");
    expect(appSource).toContain("Workflow output is available after the run completes.");
    expect(appSource).toContain("No workflow output recorded");
    expect(appSource).toContain("Input Contract");
    expect(appSource).toContain("Output Mapping");
  });

  it("uses structured feedback states", () => {
    expect(appSource).toContain("function StateBlock");
    expect(appSource).toContain('role={tone === "error" ? "alert" : tone === "loading" ? "status" : undefined}');
    expect(appSource).toContain('aria-busy={tone === "loading" ? true : undefined}');
    expect(appSource).toContain('className="state-skeleton"');
    expect(styles).toContain(".state-block {");
    expect(styles).toContain(".state-block.error");
    expect(styles).toContain(".state-block > div");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).toContain(".state-skeleton-line");
    expect(styles).toContain("@keyframes state-skeleton-sheen");
    const reducedMotion = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toContain(".state-block.loading .state-block-icon svg");
    expect(reducedMotion).toContain(".state-skeleton-line");
  });

  it("lets workflow visualization consume the remaining workspace width", () => {
    expect(styles).toContain(".runtime-grid > .graph-inspection-layout");
    expect(styles).toContain("grid-template-columns: minmax(300px, 360px) minmax(0, 1fr)");
    expect(appSource).toContain('import { StaticGraphApp } from "./StaticGraphApp.js";');
    expect(appSource).toContain("<StaticGraphApp data={result} />");
    expect(styles).toContain(".workflow-viz-grid > .static-viz-root");
    expect(styles).toContain("@media (max-width: 980px)");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(styles).toContain("grid-template-rows: minmax(180px, 34vh) minmax(420px, 1fr)");
  });

  it("uses a dedicated workflow source picker with tabs and breadcrumbs", () => {
    expect(appSource).toContain("function WorkflowSourcePicker");
    expect(appSource).toContain("function WorkflowCatalogList");
    expect(appSource).toContain("function WorkflowFileSelector");
    expect(appSource).toContain("function WorkflowBreadcrumb");
    expect(appSource).toContain('<Tabs value={activeTab}');
    expect(appSource).toContain('TabsTrigger value="catalog"');
    expect(appSource).toContain('TabsTrigger value="files"');
    expect(appSource).toContain('aria-label="Workspace path"');
    expect(appSource).toContain("Filter current directory");
    expect(appSource).toContain("onVisualize={() => source && visualize.mutate(source)}");
    expect(styles).toContain(".workflow-picker");
    expect(styles).toContain(".workflow-picker-tabs-list");
    expect(styles).toContain(".workflow-file-selector");
    expect(styles).toContain(".workflow-breadcrumb");
    expect(styles).toContain(".workflow-source-table");
    expect(styles).toContain(".workflow-list-row");
    expect(styles).toContain(".workflow-picker-footer");
    expect(styles).toContain("overflow: auto");
  });

  it("animates the status popover with reduced-motion fallback", () => {
    expect(styles).toContain("@keyframes status-dialog-in");
    expect(styles).toContain("animation: status-dialog-in 220ms var(--ease-out-strong) both");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    const reducedMotion = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toContain("animation: none");
    expect(reducedMotion).toContain(".status-info-popover");
    expect(reducedMotion).toContain(".inspector-card.exiting");
    expect(styles).toContain(".inspector-card.exiting");
    expect(styles).toContain(".graph-flow-shell.viewport-animating .graph-canvas");
    expect(styles).toContain("--ui-shadow-panel:");
    expect(styles).toContain("0 18px 44px rgb(10 10 10 / 0.14)");
  });

  it("renders graph nodes with stronger card hierarchy while containers stay structural", () => {
    expect(styles).toContain("border: 2px solid var(--color-sera-outlineVariant)");
    expect(styles).toMatch(/\.graph-box\s*\{[\s\S]*box-sizing: border-box;[\s\S]*border: 2px solid var\(--color-sera-outlineVariant\)/);
    expect(styles).toMatch(/\.node-card\s*\{[\s\S]*height: 100%;[\s\S]*box-sizing: border-box;/);
    expect(styles).toContain("linear-gradient(0deg, var(--graph-kind-surface), var(--graph-kind-surface))");
    expect(styles).toContain("0 10px 22px rgb(10 10 10 / 0.10)");
    expect(styles).toContain(".node-card-head svg");
    expect(styles).toContain("color: var(--graph-kind, var(--color-sera-muted))");
    expect(styles).toContain("color: var(--graph-kind-pill-text, var(--graph-kind, var(--color-sera-muted)))");
    expect(styles).toContain("--graph-kind: #6f8a6a");
    expect(styles).toContain("--graph-kind-border: rgb(111 138 106 / 0.88)");
    expect(styles).toContain("--graph-kind-pill-bg: rgb(111 138 106 / 0.18)");
    expect(styles).toContain("--graph-kind-pill-border: rgb(111 138 106 / 0.48)");
    expect(styles).toContain("--graph-kind-pill-text: #42583f");
    expect(styles).toContain("--graph-kind-surface: rgb(111 138 106 / 0.05)");
    expect(styles).toContain("0 8px 18px rgb(10 10 10 / 0.07)");
    expect(styles).toContain("border: 1px dashed rgb(10 10 10 / 0.28)");
    expect(styles).toContain("border-color: rgb(10 10 10 / 0.2)");
  });

  it("keeps WebUI styling behind semantic tokens and avoids side-tab toast slop", () => {
    expect(styles).toContain("--ui-canvas:");
    expect(styles).toContain("--ui-canvas: #f7f7f5");
    expect(styles).toContain("--color-sera-muted: #5f5f5b");
    const themeBlock = styles.slice(styles.indexOf("@theme {"), styles.indexOf("/* Base */"));
    expect(themeBlock).toContain("--radius-xl: 0");
    expect(styles).toContain("--ui-surface-raised:");
    expect(styles).toContain("--z-graph-edge: 0");
    expect(styles).toContain("--z-graph-status: 19");
    expect(styles).toContain("--z-graph-toolbar: 20");
    expect(styles).toContain("--z-overlay: 55");
    expect(styles).toContain("--z-toast: 60");
    expect(styles).toContain("z-index: var(--z-overlay)");
    expect(styles).toContain("z-index: var(--z-toast)");
    expect(styles).toContain("z-index: var(--z-graph-toolbar)");
    expect(styles).toContain("--ui-shadow-card:");
    expect(styles).toContain("0 10px 24px rgb(10 10 10 / 0.10)");
    expect(styles).toContain("--ui-shadow-card:");
    expect(styles).toContain(".toast {");
    expect(styles).toContain("--toast-color:");
    expect(styles).toContain(".toast.success");
    expect(styles).toContain("--toast-border: rgb(10 10 10 / 0.34)");
    expect(toastSource).toContain('role={toast.tone === "error" ? "alert" : "status"}');
    expect(toastSource).toContain('aria-live={toast.tone === "error" ? "assertive" : "polite"}');
    expect(toastSource).toContain('aria-atomic="true"');
  });

  it("provides a shared focus-visible treatment for command surfaces", () => {
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("outline: 2px solid var(--ui-focus)");
    expect(styles).toContain(".nav-button");
    expect(styles).toContain(".icon-button");
    expect(styles).toContain(".close-button");
    expect(styles).toContain(".toast-close");
    expect(styles).toContain(".primary-button");
    expect(styles).toContain(".run-row");
    expect(styles).toContain(".search-input");
    expect(styles).toContain(".run-select");
    expect(styles).toContain(".workflow-list-row");
    expect(styles).toContain(".breadcrumb-button");
    expect(styles).toContain(".ui-input");
    expect(styles).toContain(".select-trigger");
    expect(styles).toContain(".ui-textarea");
    expect(styles).toContain(".json-copy-button");
    expect(styles).toContain(".signal-box textarea");
    expect(styles).toContain(".signal-box .signal-error");
    expect(styles).toContain(".select-trigger > span");
    expect(styles).toContain(".select-item [data-radix-select-item-text]");
    expect(styles).toContain(".confirm-dialog");
    expect(styles).toContain("box-sizing: border-box");
    expect(styles).toContain(".ui-button");
    expect(styles).toContain(".ui-card");
    expect(styles).toContain(".tabs-list");
  });

  it("does not let sidebar hover styling mask the active entry", () => {
    expect(appSource).toContain("const [sidebarCollapsed, setSidebarCollapsed] = useState(true)");
    expect(appSource).toContain('className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}');
    expect(styles).toContain(".nav-button.active");
    expect(styles).toContain(".nav-button:not(.active):hover");
  });

  it("gives common controls explicit accessible names", () => {
    expect(appSource).toContain('aria-label="Select run"');
    expect(appSource).toContain("aria-current={active ? \"page\" : undefined}");
    expect(appSource).toContain("aria-label={label}");
    expect(appSource).toContain('aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}');
    expect(appSource).toContain('aria-label="Workspace path"');
    expect(appSource).toContain('aria-current={target === dir ? "page" : undefined}');
    expect(appSource).toContain('aria-label="Filter current directory"');
    expect(appSource).toContain('aria-label="Signal payload JSON"');
    expect(appSource).toContain("Signal payload must be valid JSON.");
    expect(appSource).toContain('role="alert"');
  });

  it("uses shadcn dialog and popover primitives for modal and status interactions", () => {
    const confirmDialogSource = appSource.slice(
      appSource.indexOf("function ConfirmDialog"),
      appSource.indexOf("function Inspector({"),
    );
    const statusDialogSource = appSource.slice(
      appSource.indexOf("function StatusInfoPopover"),
      appSource.indexOf("const SidebarStatus"),
    );
    const sidebarStatusSource = appSource.slice(
      appSource.indexOf("const SidebarStatus"),
      appSource.indexOf("function sidebarStatusIcon"),
    );
    expect(confirmDialogSource).toContain("<Dialog open");
    expect(confirmDialogSource).toContain("<DialogContent");
    expect(confirmDialogSource).toContain("onCloseAutoFocus");
    expect(confirmDialogSource).toContain("restoreFocus?.focus()");
    expect(confirmDialogSource).toContain("<DialogTitle");
    expect(confirmDialogSource).toContain("<DialogDescription");
    expect(statusDialogSource).toContain("<PopoverContent");
    expect(statusDialogSource).toContain("<PopoverClose asChild>");
    expect(sidebarStatusSource).toContain("React.forwardRef");
    expect(sidebarStatusSource).toContain("...props");
    expect(sidebarStatusSource).toContain("ref={ref}");
  });
});
