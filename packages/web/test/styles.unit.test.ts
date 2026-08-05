import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
const nodeKinds = ["task", "agent", "signal", "assert", "if", "switch", "parallel", "fanout", "loop"] as const;
const gruvboxKindAccents = new Set(["#83a598", "#d3869b", "#fabd2f", "#fb7b6b", "#b8bb26", "#c08bb5", "#7daea3", "#fe8019", "#d5c4a1"]);
const gruvboxKindBorders = new Set(["#458588", "#b16286", "#d79921", "#d1614f", "#8f9218", "#a07590", "#56838c", "#d65d0e", "#a89984"]);

describe("workflow graph visual contract", () => {
  it("anchors the WebUI in the Gruvbox-derived Acpus Ink dark theme", () => {
    expect(declaration(styles, "--theme-accent")).toBe("#fe8019");
    expect(declaration(styles, "--theme-ink")).toBe("#ebdbb2");
    expect(declaration(styles, "--theme-surface")).toBe("#282828");
    expect(styles).toContain("color-scheme: dark;");
  });

  it("keeps primary actions orange and disabled actions inside the dark surface family", () => {
    expect(rule(".primary-button")).toContain("background: var(--theme-accent);");
    expect(rule(".primary-button")).toContain("color: var(--theme-surface-raised);");
    expect(rule(".primary-button:disabled")).toContain("background: var(--theme-surface-muted);");
    expect(rule(".primary-button:disabled")).toContain("color: var(--ui-text-muted);");
  });

  it("confines approved node-kind colors to readable highlights on neutral surfaces", () => {
    const surface = declaration(styles, "--graph-node-surface");
    const badge = declaration(styles, "--graph-kind-pill-bg");
    const palettes = nodeKinds.map(kind => {
      const block = rule(`.graph-box.node.${kind}`);
      return {
        kind,
        accent: declaration(block, "--graph-kind"),
        border: declaration(block, "--graph-kind-border"),
        block,
      };
    });

    expect(declaration(styles, "--graph-canvas-surface")).toBe("#1d2021");
    expect(surface).toBe("#35312f");
    expect(declaration(styles, "--graph-composite-surface")).toBe("#32302f");
    expect(declaration(styles, "--graph-structural-surface")).toBe("#282828");
    expect(declaration(styles, "--graph-composite-border")).toBe("#665c54");
    expect(badge).toBe("#282828");
    expect(rule(".graph-box.node")).toContain("background: var(--graph-node-surface);");
    expect(rule(".graph-box.node:is(.parallel, .fanout, .switch, .loop, .if)")).toContain("background: var(--graph-composite-surface);");
    expect(palettes.slice(0, 3).map(({ kind, accent }) => ({ kind, accent }))).toEqual([
      { kind: "task", accent: "#fabd2f" },
      { kind: "agent", accent: "#7daea3" },
      { kind: "signal", accent: "#d3869b" },
    ]);
    expect(new Set(palettes.map(({ accent }) => accent))).toHaveLength(nodeKinds.length);

    for (const palette of palettes) {
      expect(gruvboxKindAccents.has(palette.accent), `${palette.kind} accent`).toBe(true);
      expect(gruvboxKindBorders.has(palette.border), `${palette.kind} border`).toBe(true);
      expect(palette.block, `${palette.kind} surface override`).not.toMatch(/--graph-kind-(?:surface|pill-bg)/);
      expect(contrast(palette.accent, surface), `${palette.kind} icon`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.border, surface), `${palette.kind} border`).toBeGreaterThanOrEqual(3);
      expect(contrast(palette.accent, badge), `${palette.kind} badge`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses graph-only soft elevation while structural containers stay flat", () => {
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
    expect(rule(".graph-box.node.selected")).toContain("--graph-node-elevation: var(--graph-node-shadow-hover);");
    expect(rule(".graph-box.node.runtime-active")).toContain("--graph-node-elevation: var(--graph-node-shadow-active);");
    expect(rule(".graph-box.node:hover")).toContain("--graph-node-elevation: var(--graph-node-shadow-hover);");
    expect(rule(".graph-box.graph-container")).not.toMatch(/graph-node-shadow|graph-node-elevation|box-shadow/);
    expect(rule(".graph-box.graph-container.runtime-active")).toContain("outline: 2px solid var(--runtime-status-border);");
    expect(rule(".graph-box.graph-container.runtime-active")).not.toContain("box-shadow");
  });

  it("reserves a rounded side keyline for Task, Agent, and Signal leaves", () => {
    const primaryLeaves = rule(".graph-box.node:is(.task, .agent, .signal)");

    expect(declaration(styles, "--graph-leaf-radius")).toBe("4px");
    expect(declaration(styles, "--graph-leaf-side-width")).toBe("4px");
    expect(primaryLeaves).toContain("border-width: 1px;");
    expect(primaryLeaves).toContain("border-inline-start-width: var(--graph-leaf-side-width);");
    expect(primaryLeaves).toContain("border-inline-start-color: var(--graph-kind);");
    expect(primaryLeaves).toContain("border-radius: var(--graph-leaf-radius);");
    expect(rule(".graph-box.node:is(.parallel, .fanout, .switch, .loop, .if)")).toContain("border-radius: 0;");
    expect(rule(".graph-box.node:is(.parallel, .fanout, .switch, .loop, .if)")).not.toContain("border-inline-start");
    expect(rule(".graph-box.graph-container")).toContain("border-radius: 0;");
    expect(rule(".graph-box.graph-container")).not.toContain("border-inline-start");
  });

  it("keeps graph kind tags quiet and loop iteration selectors compact but complete", () => {
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

  it("uses a top-right semantic stamp for runtime status instead of node-kind color", () => {
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
    expect(rule(".node-card-meta")).toContain("padding-inline-end: 28px;");
    expect(rule(".graph-box-header")).toContain("padding: 10px 42px 10px 12px;");
    expect(rule(".graph-box.runtime-status-completed")).toContain("--runtime-status-color: var(--ui-success-text);");
    expect(rule(".graph-box.runtime-status-failed")).toContain("--runtime-status-color: var(--ui-danger-text);");
    expect(rule(".graph-box.runtime-status-canceled")).toContain("--runtime-status-color: var(--ui-danger-text);");
    expect(rule(".graph-box.runtime-status-running")).toContain("--runtime-status-color: var(--ui-accent-text);");
    expect(rule(".graph-box.runtime-status-awaiting")).toContain("--runtime-status-color: #83a598;");
    expect(rule(".graph-box.runtime-status-paused")).toContain("--runtime-status-color: #d3869b;");
    expect(rule(".graph-box.runtime-status-queued")).toContain("--runtime-status-color: #b0b4aa;");
    expect(rule(".graph-box.runtime-status-skipped")).toContain("--runtime-status-color: #a89984;");
  });

  it("keeps graph navigation utilities aligned with the viewport icon controls", () => {
    expect(rule(".graph-toolbar")).toContain("align-items: center;");
    expect(rule(".graph-toolbar")).toContain("gap: 2px;");
    expect(rule(".graph-tool-button")).toContain("width: 28px;");
    expect(rule(".graph-tool-button")).toContain("height: 28px;");
  });

  it("uses a restrained, readable minimap viewport treatment", () => {
    expect(rule(".graph-minimap-viewport-shade")).toContain("fill: rgb(var(--theme-surface-rgb) / 0.42);");
    expect(rule(".graph-minimap-viewport")).toContain("fill: transparent;");
    expect(rule(".graph-minimap-viewport")).toContain("stroke-width: 2px;");
    expect(rule(".graph-minimap-viewport")).toContain("vector-effect: non-scaling-stroke;");
  });

  it("lets the Run selector grow left while constraining long values inside its trigger", () => {
    expect(rule(".run-select-wrap")).toContain("min-width: 0;");
    expect(rule(".run-select-wrap > span")).toContain("flex: 0 0 auto;");
    expect(rule(".run-select")).toContain("width: min(480px, 44vw);");
    expect(rule(".select-trigger > span")).toContain("min-width: 0;");
    expect(rule(".select-trigger > span")).toContain("overflow: hidden;");
    expect(rule(".select-trigger > span")).toContain("text-overflow: ellipsis;");
  });

  it("uses opaque filled arrowheads that match the graph's quiet sequence strokes", () => {
    expect(rule(".graph-edges marker")).toContain("color: #676355;");
    expect(rule(".graph-edges marker path")).toContain("fill: currentColor;");
    expect(rule(".graph-edges marker path")).toContain("stroke: none;");
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
  const values = [first, second].map(luminance).sort((left, right) => right - left);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function luminance(color: string): number {
  if (!/^#[\da-f]{6}$/i.test(color)) throw new Error(`Expected a six-digit hex color, received ${color}`);
  const channels = color.slice(1).match(/../g)!.map(channel => Number.parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
