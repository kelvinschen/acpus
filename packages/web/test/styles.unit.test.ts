import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
const nodeKinds = ["task", "agent", "signal", "assert", "if", "switch", "parallel", "fanout", "loop"] as const;
const paperRelayKinds = {
  task: ["#765600", "#a57a00"],
  agent: ["#0737a7", "#3c64b9"],
  signal: ["#8a2d5b", "#a85a94"],
  assert: ["#a12a23", "#c65a50"],
  if: ["#246b37", "#4b8858"],
  switch: ["#5b3aa4", "#7c5ab7"],
  parallel: ["#006b68", "#338987"],
  fanout: ["#943800", "#b96524"],
  loop: ["#4f4a45", "#79736c"],
} as const;

describe("Paper Relay visual contract", () => {
  it("records the canonical light foundation and typography", () => {
    expect(resolvedDeclaration("--ui-canvas")).toBe("#faf8f3");
    expect(resolvedDeclaration("--ui-surface")).toBe("#fffefb");
    expect(resolvedDeclaration("--ui-surface-raised")).toBe("#fff");
    expect(resolvedDeclaration("--ui-surface-muted")).toBe("#f1eee7");
    expect(resolvedDeclaration("--ui-ink")).toBe("#252828");
    expect(resolvedDeclaration("--ui-text-muted")).toBe("#625f58");
    expect(resolvedDeclaration("--ui-primary")).toBe("#0a46d4");
    expect(resolvedDeclaration("--ui-primary-text")).toBe("#0737a7");
    expect(resolvedDeclaration("--ui-accent")).toBe("#fa7408");
    expect(resolvedDeclaration("--ui-accent-text")).toBe("#943800");
    expect(resolvedDeclaration("--ui-success")).toBe("#087445");
    expect(resolvedDeclaration("--ui-danger")).toBe("#c63525");
    expect(resolvedDeclaration("--ui-awaiting")).toBe("#934000");
    expect(resolvedDeclaration("--ui-paused")).toBe("#6b3fa0");
    expect(styles).toContain("color-scheme: light;");
    expect(declaration(styles, "--font-sans")).toContain('"Outfit"');
    expect(declaration(styles, "--font-mono")).toContain('"IBM Plex Mono"');
  });

  it("records and applies compact graph workspace spacing", () => {
    expect(declaration(styles, "--ui-workspace-inset")).toBe("20px 24px");
    expect(declaration(styles, "--ui-region-gap")).toBe("16px");
    expect(declaration(styles, "--ui-panel-gap")).toBe("12px");
    expect(rule(".workspace")).toContain("padding: var(--ui-workspace-inset);");
    expect(rule(".run-monitor-grid")).toContain("gap: var(--ui-region-gap);");
    expect(rule(".graph-inspection-layout.with-inspector")).toContain("gap: var(--ui-panel-gap);");
    expect(rule(".workflow-viz-grid")).toContain("gap: var(--ui-region-gap);");
  });

  it("uses accessible brand combinations and a restrained paper canvas", () => {
    expect(contrast(resolvedDeclaration("--ui-ink"), resolvedDeclaration("--ui-canvas"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolvedDeclaration("--ui-text-muted"), resolvedDeclaration("--ui-canvas"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolvedDeclaration("--ui-on-solid"), resolvedDeclaration("--ui-primary"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolvedDeclaration("--ui-ink"), resolvedDeclaration("--ui-accent"))).toBeGreaterThanOrEqual(4.5);
    expect(rule(".app-shell")).toContain("background-color: var(--ui-canvas);");
    expect(rule(".app-shell")).toContain("radial-gradient(");
    expect(rule(".graph-flow-shell")).not.toContain("radial-gradient(");
  });

  it("gives primary actions and selected navigation the Paper Relay hierarchy", () => {
    expect(rule(".primary-button")).toContain("background: var(--ui-primary);");
    expect(rule(".primary-button")).toContain("color: var(--ui-on-solid);");
    expect(rule(".primary-button")).toContain("box-shadow: var(--ui-shadow-control);");
    expect(rule(".primary-button:disabled")).toContain("background: var(--ui-surface-muted);");
    expect(rule(".primary-button:disabled")).toContain("color: var(--ui-text-muted);");
    expect(rule(".primary-button:disabled")).toContain("box-shadow: none;");
    expect(rule(".nav-button.active")).toContain("background: var(--ui-accent);");
    expect(rule(".nav-button.active")).toContain("color: var(--ui-ink);");
    expect(rule(".nav-button.active")).toContain("box-shadow: 3px 4px 0 var(--ui-ink);");
    expect(rule(".sidebar")).toContain("border-right: 2px solid var(--ui-ink);");
  });

  it("uses a responsive, softly elevated Runs card grid", () => {
    expect(rule(".runs-page")).toContain("grid-template-rows: auto minmax(0, 1fr);");
    expect(rule(".runs-page-content")).toContain("overflow: auto;");
    expect(rule(".runs-card-grid")).toContain("repeat(auto-fill, minmax(min(100%, 340px), 1fr))");

    const card = rule(".run-card");
    expect(card).toContain("border-radius: 0;");
    expect(card).toContain("box-shadow: var(--ui-shadow-card);");
    expect(card).not.toContain("var(--ui-shadow-panel)");
    expect(card).not.toContain("transition: all");
    expect(rule(".run-card:focus-visible")).toContain("outline: 2px solid var(--ui-focus);");
    expect(rule(".run-select:focus-visible")).toContain("outline: 2px solid var(--ui-focus);");
    expect(rule(".run-card-metric dd")).toContain("font-variant-numeric: tabular-nums;");
    expect(rule(".run-select-option-meta")).toContain("font-variant-numeric: tabular-nums;");
  });

  it("uses a short directional Runs to Monitor workspace transition", () => {
    expect(rule(".workspace")).not.toContain("view-transition-name:");
    expect(rule("html[data-run-transition]")).toContain("view-transition-name: none;");
    expect(rule('html[data-run-transition] .workspace')).toContain("view-transition-name: acpus-run-surface;");
    expect(rule("::view-transition-group(acpus-run-surface)")).toContain("overflow: clip;");

    expect(rule('html[data-run-transition="forward"]::view-transition-old(acpus-run-surface)'))
      .toContain("animation: run-surface-forward-out 150ms var(--ease-out-strong) both;");
    expect(rule('html[data-run-transition="forward"]::view-transition-new(acpus-run-surface)'))
      .toContain("animation: run-surface-forward-in 240ms var(--ease-out-strong) both;");
    expect(rule('html[data-run-transition="back"]::view-transition-old(acpus-run-surface)'))
      .toContain("animation: run-surface-back-out 150ms var(--ease-out-strong) both;");
    expect(rule('html[data-run-transition="back"]::view-transition-new(acpus-run-surface)'))
      .toContain("animation: run-surface-back-in 240ms var(--ease-out-strong) both;");

    const reducedMotion = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toContain("html[data-run-transition]::view-transition-old(acpus-run-surface),");
    expect(reducedMotion).toContain("animation: none;");
    expect(styles).not.toContain("transition: all");
  });

  it("keeps raw visual colors inside the token block", () => {
    const themeStart = styles.indexOf("@theme {");
    const themeEnd = styles.indexOf("\n}\n", themeStart);
    expect(themeStart).toBeGreaterThanOrEqual(0);
    expect(themeEnd).toBeGreaterThan(themeStart);
    expect(styles.slice(themeEnd + 3)).not.toMatch(/#[\da-f]{3,8}\b|rgb\(\s*\d/i);
  });
});

describe("workflow graph visual contract", () => {
  it("packs Inspector identity and context into two non-wrapping rows", () => {
    expect(rule(".inspector-card-title")).toContain("flex: 1 1 auto;");
    expect(rule(".inspector-card-title-line")).toContain("flex-wrap: nowrap;");
    const subtitle = rule(".inspector-card-title > small");
    expect(subtitle).toContain("white-space: nowrap;");
    expect(subtitle).toContain("overflow: hidden;");
    expect(subtitle).toContain("text-overflow: ellipsis;");
    expect(subtitle).not.toContain("overflow-wrap: anywhere;");
  });

  it("lets the Artifact list consume the remaining Inspector height and scroll independently", () => {
    for (const selector of [".inspector-card-body", ".inspector-stack", ".inspector-tab-shell", ".inspector-tab-panel", ".artifact-stack"]) {
      expect(rule(selector), selector).toContain("min-height: 0;");
    }

    expect(rule(".inspector-card-body")).toContain("overflow-y: auto;");
    expect(rule(".inspector-stack")).toContain("overflow: visible;");
    expect(rule(".inspector-stack.tabbed")).toContain("overflow: hidden;");
    expect(rule(".inspector-tab-shell")).toContain("flex: 1;");
    expect(rule(".inspector-tab-panel")).toContain("overflow-y: auto;");
    expect(rule(".inspector-tab-panel.artifacts-panel")).toContain("overflow: hidden;");
    expect(rule(".artifact-stack")).toContain("flex: 1;");
    expect(rule(".artifact-stack")).toContain("overflow: hidden;");
    expect(rule(".artifact-list")).toContain("flex: 1 1 auto;");
    expect(rule(".artifact-list")).toContain("overflow-y: auto;");
  });

  it("makes each Artifact row the single accessible full-view action", () => {
    const row = rule(".artifact-row");
    expect(row).toContain("min-height: 44px;");
    expect(row).toContain("grid-template-columns: minmax(0, 1fr) auto auto auto;");
    expect(row).toContain("cursor: pointer;");
    expect(row).toContain("transition: background-color 120ms var(--ease-out-strong), border-color 120ms var(--ease-out-strong), color 120ms var(--ease-out-strong), opacity 120ms var(--ease-out-strong);");
    expect(rule(".artifact-view-cue")).toContain("color: var(--ui-primary-text);");
    expect(rule(".artifact-row:disabled")).toContain("cursor: not-allowed;");
  });

  it("uses a context-preserving full-screen Artifact reading surface", () => {
    const viewer = rule(".artifact-viewer.dialog-content");
    expect(viewer).toContain("inset: 0;");
    expect(viewer).toContain("width: 100dvw;");
    expect(viewer).toContain("height: 100dvh;");
    expect(viewer).toContain("grid-template-rows: auto minmax(0, 1fr);");
    expect(viewer).toContain("border: 0;");
    expect(viewer).toContain("box-shadow: none;");
    expect(styles).not.toContain(".artifact-viewer-overlay");
    expect(rule(".artifact-viewer-body")).toContain("overflow: hidden;");
    expect(rule(".artifact-viewer-document")).toContain("overflow: auto;");
    expect(rule(".markdown-document.reading")).toContain("width: min(100%, 72ch);");
    expect(rule(".artifact-viewer-mode,\n.artifact-viewer-action,\n.artifact-viewer-close,\n.artifact-viewer-retry"))
      .toContain("min-height: 44px;");
    expect(rule(".artifact-viewer-close")).toContain("flex: 0 0 44px;");

    const narrowStart = styles.indexOf("@media (max-width: 640px)");
    const narrow = styles.slice(narrowStart, styles.indexOf("@media", narrowStart + 1));
    expect(narrow).toContain(".artifact-viewer-action-strip");
    expect(narrow).toContain("overflow-x: auto;");
  });

  it("gives inline and full-view Markdown one complete reading system", () => {
    const compact = rule(".markdown-document.compact");
    expect(compact).toContain("max-height: 360px;");
    expect(compact).toContain("overflow: auto;");
    expect(compact).toContain("background: var(--ui-surface-muted);");

    const reading = rule(".markdown-document.reading");
    expect(reading).toContain("width: min(100%, 72ch);");
    expect(reading).toContain("line-height: 1.74;");
    expect(rule(".markdown-document h2")).toContain("border-bottom: 1px solid var(--ui-border);");
    expect(rule(".markdown-document ul")).toContain("list-style: disc;");
    expect(rule(".markdown-document ol")).toContain("list-style: decimal;");
    expect(rule(".markdown-document blockquote")).toContain("border-inline-start: 3px solid var(--ui-primary);");
    expect(rule(".markdown-table-wrap")).toContain("overflow-x: auto;");
    expect(rule(".markdown-document :where(th, td)")).toContain("border: 1px solid var(--ui-border);");
    expect(rule(".markdown-document .task-list-item-checkbox")).toContain("accent-color: var(--ui-primary);");
    expect(rule(".markdown-code-block")).toContain("border: 1px solid var(--ui-border);");
    expect(rule(".markdown-mermaid")).toContain("background: var(--ui-surface-raised);");
    expect(rule(".markdown-mermaid")).toContain("border: 1px solid var(--ui-border);");
    expect(rule(".markdown-mermaid-canvas")).toContain("overflow: auto;");
    expect(rule(".markdown-mermaid-canvas")).toContain("overscroll-behavior-inline: contain;");
    expect(rule(".markdown-mermaid-canvas:focus-visible")).toContain("outline: 2px solid var(--ui-focus);");
    expect(rule(".markdown-mermaid-canvas > svg")).toContain("max-width: none;");
    expect(rule('.markdown-mermaid[data-mermaid-state="error"] .markdown-mermaid-status'))
      .toContain("color: var(--ui-danger);");
    expect(rule(".markdown-document img")).toContain("outline: 1px solid rgb(var(--ui-ink-rgb) / 0.1);");
  });

  it("keeps Artifact Viewer motion short and removes it for reduced motion", () => {
    expect(rule('.artifact-viewer.dialog-content[data-state="open"]'))
      .toContain("animation: artifact-viewer-in 160ms var(--ease-out-strong) both;");
    expect(rule('.artifact-viewer.dialog-content[data-state="closed"]'))
      .toContain("animation: artifact-viewer-out 120ms var(--ease-out-strong) both;");
    const reducedMotion = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toContain(".artifact-viewer.dialog-content,");
    expect(reducedMotion).toContain("animation: none;");
    expect(reducedMotion).toContain("transform: none;");
  });

  it("groups Inspector items more tightly than their section heading", () => {
    const sectionBody = rule(".inspector-section-body");
    const keyValue = rule(".key-value");
    const headingGap = pixelLength(declaration(sectionBody, "margin-top"));
    const itemGap = pixelLength(declaration(sectionBody, "gap"));
    const itemPadding = pixelLength(declaration(keyValue, "padding-block"));
    const titleToFirstItem = headingGap + itemPadding;
    const betweenItems = itemGap + itemPadding * 2;

    expect(titleToFirstItem).toBeGreaterThanOrEqual(betweenItems * 2);
  });

  it("uses neutral Paper Relay graph surfaces and readable opaque edges", () => {
    expect(resolvedDeclaration("--graph-canvas")).toBe("#f5f2eb");
    expect(resolvedDeclaration("--graph-node")).toBe("#fff");
    expect(resolvedDeclaration("--graph-composite")).toBe("#fffefb");
    expect(resolvedDeclaration("--graph-structure")).toBe("#faf8f3");
    expect(resolvedDeclaration("--graph-edge")).toBe("#625e57");
    expect(resolvedDeclaration("--graph-edge-muted")).toBe("#79736c");
    expect(resolvedDeclaration("--graph-edge-active")).toBe("#0737a7");
    expect(contrast(resolvedDeclaration("--graph-edge"), resolvedDeclaration("--graph-canvas"))).toBeGreaterThanOrEqual(3);
    expect(contrast(resolvedDeclaration("--graph-edge-muted"), resolvedDeclaration("--graph-canvas"))).toBeGreaterThanOrEqual(3);
    expect(contrast(resolvedDeclaration("--graph-edge-active"), resolvedDeclaration("--graph-canvas"))).toBeGreaterThanOrEqual(4.5);
    expect(rule(".graph-box.node")).toContain("background: var(--graph-node);");
    expect(rule(".graph-box.node:is(.parallel, .fanout, .switch, .loop, .if)")).toContain("background: var(--graph-composite);");
    expect(rule(".graph-box.graph-container")).toContain("background: var(--graph-structure);");
    expect(rule(".graph-edge.sequence")).toContain("stroke: var(--graph-edge);");
    expect(rule(".graph-edge.branch")).toContain("stroke: var(--graph-edge-muted);");
    expect(rule(".graph-edge.loop")).toContain("stroke: var(--graph-edge-muted);");
    expect(rule(".graph-edge.active")).toContain("var(--graph-edge-active)");
    expect(rule(".graph-edges marker")).toContain("color: var(--graph-edge);");
  });

  it("makes dashed Loop returns stronger than structural branch edges", () => {
    const loop = rule(".graph-edge.loop");
    const branch = rule(".graph-edge.branch");

    expect(loop).toContain("stroke: var(--graph-edge-muted);");
    expect(loop).toContain("stroke-dasharray: 6 4;");
    expect(Number(declaration(loop, "stroke-width"))).toBe(1.8);
    expect(Number(declaration(loop, "stroke-width"))).toBeGreaterThan(Number(declaration(branch, "stroke-width")));
  });

  it("confines the complete accessible node-kind palette to identity cues", () => {
    const nodeSurface = resolvedDeclaration("--graph-node");
    const kindSurface = resolvedDeclaration("--graph-kind-surface");

    for (const kind of nodeKinds) {
      const [foreground, border] = paperRelayKinds[kind];
      const block = rule(`.graph-box.node.${kind},\n.node-kind-badge.${kind}`);
      expect(resolvedDeclaration(`--graph-kind-${kind}`)).toBe(foreground);
      expect(resolvedDeclaration(`--graph-kind-${kind}-border`)).toBe(border);
      expect(block).toContain(`--graph-kind: var(--graph-kind-${kind});`);
      expect(block).toContain(`--graph-kind-border: var(--graph-kind-${kind}-border);`);
      expect(block).not.toMatch(/--graph-(?:node|composite|structure)\s*:/);
      expect(contrast(foreground, nodeSurface), `${kind} icon`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(foreground, kindSurface), `${kind} badge`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(border, nodeSurface), `${kind} border`).toBeGreaterThanOrEqual(3);
    }
    expect(rule(".node-card-meta svg,\n.composite-title svg,\n.node-kind-badge svg")).toContain("color: var(--graph-kind, var(--ui-text-muted));");
  });

  it("retains soft graph elevation while application plates stay bold", () => {
    for (const token of ["--graph-node-shadow-rest", "--graph-node-shadow-hover", "--graph-node-shadow-active"]) {
      const shadow = declaration(styles, token);
      const layers = shadowLayers(shadow);
      expect(layers.length, token).toBeGreaterThanOrEqual(2);
      for (const layer of layers) {
        const metrics = layer.match(/^(-?\d+)(?:px)?\s+(-?\d+)(?:px)?\s+(\d+)px\s+(-?\d+)px\s/);
        expect(metrics, `${token}: ${layer}`).not.toBeNull();
        expect(Math.abs(Number(metrics![1])), `${token} x-offset`).toBeLessThanOrEqual(16);
        expect(Math.abs(Number(metrics![2])), `${token} y-offset`).toBeLessThanOrEqual(16);
        expect(Number(metrics![3]), `${token} blur`).toBeGreaterThan(0);
        expect(Number(metrics![4]), `${token} spread`).toBeLessThanOrEqual(0);
        for (const alpha of layer.matchAll(/\/\s*(0?\.\d+)\)/g)) {
          expect(Number(alpha[1]), `${token} alpha`).toBeLessThanOrEqual(0.28);
        }
      }
    }

    expect(rule(".graph-box.node")).toContain("box-shadow: var(--graph-node-elevation);");
    expect(rule(".graph-box.node")).not.toMatch(/ui-shadow-(?:control|panel)/);
    expect(rule(".graph-box.node.selected")).toContain("--graph-node-elevation: var(--graph-node-shadow-hover);");
    expect(rule(".graph-box.node.runtime-active")).toContain("--graph-node-elevation: var(--graph-node-shadow-active);");
    expect(rule(".graph-box.graph-container")).not.toMatch(/graph-node-shadow|graph-node-elevation|box-shadow/);
    expect(rule(".graph-panel")).toContain("border: 2px solid var(--ui-ink);");
    expect(rule(".inspector-card")).toContain("border: 2px solid var(--ui-ink);");
  });

  it("reserves a rounded side keyline for Task, Agent, and Signal leaves", () => {
    const primaryLeaves = rule(".graph-box.node:is(.task, .agent, .signal)");

    expect(resolvedDeclaration("--graph-leaf-radius")).toBe("4px");
    expect(resolvedDeclaration("--graph-leaf-side-width")).toBe("4px");
    expect(primaryLeaves).toContain("border-width: 1px;");
    expect(primaryLeaves).toContain("border-inline-start-width: var(--graph-leaf-side-width);");
    expect(primaryLeaves).toContain("border-inline-start-color: var(--graph-kind);");
    expect(primaryLeaves).toContain("border-radius: var(--graph-leaf-radius);");
    expect(rule(".graph-box.node:is(.parallel, .fanout, .switch, .loop, .if)")).toContain("border-radius: 0;");
    expect(rule(".graph-box.graph-container")).toContain("border-radius: 0;");
  });

  it("keeps graph kind tags and loop selectors compact", () => {
    expect(rule(".type-badge")).toContain("font-weight: 650;");
    expect(rule(".graph-selector")).toContain("padding: 4px 7px;");
    expect(rule(".graph-selector")).toContain("gap: 5px;");
    expect(rule(".graph-selector.loop")).toContain("width: 82px;");
    expect(rule(".graph-selector.loop")).toContain("min-width: 82px;");
    expect(rule(".graph-selector.loop")).toContain("max-width: 82px;");
  });

  it("reserves a dedicated full-width row for leaf node identity", () => {
    expect(rule(".node-card")).toContain("padding: 8px 12px;");
    expect(rule(".node-card-meta")).toContain("padding-inline-end: 28px;");
    expect(rule(".node-card-label")).toContain("overflow: hidden;");
    expect(rule(".node-card-label")).toContain("text-overflow: ellipsis;");
    expect(rule(".node-card-label")).toContain("white-space: nowrap;");
    expect(rule(".type-badge")).toContain("display: inline-flex;");
  });

  it("maps runtime stamps to semantic status tokens", () => {
    const stamp = rule(".runtime-status-stamp");
    expect(stamp).toContain("position: absolute;");
    expect(stamp).toContain("top: 9px;");
    expect(stamp).toContain("right: 9px;");
    expect(stamp).toContain("width: 20px;");
    expect(stamp).toContain("height: 20px;");
    expect(stamp).toContain("background: transparent;");
    expect(stamp).toContain("color: var(--runtime-status-color);");
    expect(stamp).not.toContain("border:");
    expect(stamp).not.toContain("border-radius:");

    const mappings = {
      not_started: "not-started",
      queued: "queued",
      running: "running",
      awaiting: "awaiting",
      paused: "paused",
      completed: "completed",
      failed: "failed",
      canceled: "canceled",
      skipped: "skipped",
    } as const;
    for (const [status, token] of Object.entries(mappings)) {
      expect(rule(`.graph-box.runtime-status-${status}`)).toContain(`--runtime-status-color: var(--status-${token});`);
    }
    for (const token of ["queued", "running", "awaiting", "paused", "completed", "failed", "canceled", "skipped"] as const) {
      expect(contrast(resolvedDeclaration(`--status-${token}`), resolvedDeclaration("--graph-node")), token).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps graph navigation geometry and selection semantics stable", () => {
    expect(rule(".graph-toolbar")).toContain("align-items: center;");
    expect(rule(".graph-toolbar")).toContain("gap: 2px;");
    expect(rule(".graph-tool-button")).toContain("width: 28px;");
    expect(rule(".graph-tool-button")).toContain("height: 28px;");
    expect(rule(".graph-box.node.selected")).toContain("outline: 2px solid var(--graph-selection);");
  });

  it("renders the minimap as a light topology map with a distinct viewport", () => {
    expect(declaration(styles, "--graph-viewport-shade")).toBe("rgb(var(--ui-ink-rgb) / 0.06)");
    expect(rule(".graph-minimap")).toContain("padding: 0;");
    expect(rule(".graph-minimap")).toContain("border: 1px solid var(--graph-edge-muted);");
    expect(rule(".graph-minimap")).toContain("box-shadow: none;");
    expect(rule(".graph-minimap-edge")).toContain("stroke: var(--graph-edge-muted);");
    expect(rule(".graph-minimap-edge")).toContain("vector-effect: non-scaling-stroke;");
    expect(rule(".graph-minimap-item.leaf")).toContain("fill: var(--graph-node);");
    expect(rule(".graph-minimap-item.leaf")).not.toContain("fill: var(--graph-edge-muted);");
    expect(rule(".graph-minimap-item.composite")).toContain("fill: none;");
    expect(rule(".graph-minimap-item.composite")).toContain("stroke: var(--graph-structure-border-soft);");
    expect(rule(".graph-minimap-item.node.active")).not.toContain("fill:");
    expect(rule(".graph-minimap-selection")).toContain("fill: none;");
    expect(rule(".graph-minimap-selection")).toContain("stroke: var(--graph-selection);");
    expect(rule(".graph-minimap-selection")).not.toContain("success");
    expect(rule(".graph-minimap-viewport-shade")).toContain("fill: var(--graph-viewport-shade);");
    expect(rule(".graph-minimap-viewport")).toContain("fill: transparent;");
    expect(rule(".graph-minimap-viewport")).toContain("stroke: var(--ui-accent-text);");
    expect(rule(".graph-minimap-viewport")).toContain("stroke-width: 2px;");
    expect(rule(".graph-minimap-viewport")).toContain("stroke-dasharray: 5 3;");
    expect(rule(".graph-minimap-viewport")).toContain("vector-effect: non-scaling-stroke;");
  });

  it("keeps the Run selector compact and gives its menu soft elevation", () => {
    const content = rule(".run-select-content");

    expect(rule(".run-select-wrap")).toContain("min-width: 0;");
    expect(rule(".run-select-wrap > span")).toContain("flex: 0 0 auto;");
    expect(rule(".run-select")).toContain("width: min(248px, 60vw);");
    expect(content).toContain("width: min(var(--radix-select-trigger-width), calc(100vw - 24px));");
    expect(content).toContain("min-width: 0;");
    expect(content).toContain("max-width: none;");
    expect(content).toContain("box-shadow: var(--ui-shadow-card);");
    expect(content).not.toContain("var(--ui-shadow-panel)");
    expect(rule(".select-trigger > span")).toContain("min-width: 0;");
    expect(rule(".select-trigger > span")).toContain("overflow: hidden;");
    expect(rule(".select-trigger > span")).toContain("text-overflow: ellipsis;");
  });
});

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing CSS rule: ${selector}`);
  const bodyStart = start + selector.length + 2;
  const end = styles.indexOf("\n}", bodyStart);
  if (end === -1) throw new Error(`Unclosed CSS rule: ${selector}`);
  return styles.slice(bodyStart, end);
}

function declaration(source: string, property: string): string {
  const match = source.match(new RegExp(`${property.replaceAll("-", "\\-")}\\s*:\\s*([^;]+);`));
  if (!match?.[1]) throw new Error(`Missing CSS declaration: ${property}`);
  return match[1].trim();
}

function pixelLength(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)px$/);
  if (!match?.[1]) throw new Error(`Expected a pixel length, received ${value}`);
  return Number(match[1]);
}

function resolvedDeclaration(property: string, seen = new Set<string>()): string {
  if (seen.has(property)) throw new Error(`Circular CSS token: ${[...seen, property].join(" -> ")}`);
  const value = declaration(styles, property);
  const reference = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (!reference) return value;
  return resolvedDeclaration(reference, new Set([...seen, property]));
}

function shadowLayers(shadow: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < shadow.length; index += 1) {
    if (shadow[index] === "(") depth += 1;
    if (shadow[index] === ")") depth -= 1;
    if (shadow[index] !== "," || depth !== 0) continue;
    layers.push(shadow.slice(start, index).trim());
    start = index + 1;
  }
  layers.push(shadow.slice(start).trim());
  return layers;
}

function contrast(first: string, second: string): number {
  const values = [first, second].map(normalizeHex).map(luminance).sort((left, right) => right - left);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function normalizeHex(color: string): string {
  if (/^#[\da-f]{3}$/i.test(color)) return `#${color.slice(1).split("").map(channel => channel.repeat(2)).join("")}`;
  if (!/^#[\da-f]{6}$/i.test(color)) throw new Error(`Expected a hex color, received ${color}`);
  return color;
}

function luminance(color: string): number {
  const channels = color.slice(1).match(/../g)!.map(channel => Number.parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
