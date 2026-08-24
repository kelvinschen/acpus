// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeInspection } from "../src/api-types.js";
import { ArtifactViewer, type ArtifactViewerArtifact } from "../src/client/ui/ArtifactViewer.js";
import { InspectorPanel, InspectorSection, JsonSection, KeyValue } from "../src/client/ui/Inspector.js";
import { NodeDefinitionSection } from "../src/client/ui/NodeDefinition.js";
import { NodeKindBadge } from "../src/client/ui/NodeKind.js";
import { AgentExecutionTab, Inspector } from "../src/client/ui/RunInspector.js";
import { useInspectorPresence } from "../src/client/ui/useInspectorPresence.js";
import { installReactActEnvironment, waitForReact } from "./support/react-act-environment.js";

const api = vi.hoisted(() => ({
  getArtifactContent: vi.fn(),
  getArtifactPreview: vi.fn(),
  getNodeExecutionInspection: vi.fn(),
  getNodeRuntimeValues: vi.fn(),
}));

vi.mock("../src/client/api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/client/api.js")>(),
  getArtifactContent: api.getArtifactContent,
  getArtifactPreview: api.getArtifactPreview,
  getNodeExecutionInspection: api.getNodeExecutionInspection,
  getNodeRuntimeValues: api.getNodeRuntimeValues,
}));

type Target = { id: string };
type Presence = ReturnType<typeof useInspectorPresence<Target>>;

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

let container: HTMLDivElement;
let root: Root | undefined;
let presence: Presence | undefined;
let queryClient: QueryClient | undefined;
let restoreReactActEnvironment = () => {};

function PresenceHarness({ target, onExited }: { target: Target | undefined; onExited(): void }) {
  presence = useInspectorPresence(target, onExited);
  return null;
}

async function render(element: React.ReactNode): Promise<void> {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(element);
  });
}

async function unmount(): Promise<void> {
  if (!root) return;
  const mountedRoot = root;
  root = undefined;
  await act(async () => {
    mountedRoot.unmount();
  });
}

async function renderArtifactViewer(
  artifact: ArtifactViewerArtifact,
  source: string,
  mediaType: string,
): Promise<ReturnType<typeof vi.fn>> {
  const bytes = new TextEncoder().encode(source);
  const onClose = vi.fn();
  api.getArtifactContent.mockResolvedValue({
    bytes,
    mediaType,
    size: bytes.byteLength,
    fileName: artifact.path.split("/").at(-1) ?? "artifact",
  });
  await render(React.createElement(
    QueryClientProvider,
    { client: queryClient! },
    React.createElement(ArtifactViewer, {
      workspaceKey: "ws_current",
      runId: "run_1",
      artifact,
      onClose,
    }),
  ));
  return onClose;
}

async function clickViewerButton(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>(".artifact-viewer button")]
    .find(candidate => candidate.textContent?.trim() === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

function pressedMode(): string | undefined {
  return document.querySelector<HTMLButtonElement>(".artifact-viewer-mode[aria-pressed='true']")?.textContent ?? undefined;
}

function setReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  restoreReactActEnvironment = installReactActEnvironment();
  vi.useFakeTimers();
  setReducedMotion(false);
  container = document.createElement("div");
  document.body.append(container);
  presence = undefined;
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  api.getArtifactPreview.mockReset();
  api.getArtifactContent.mockReset();
  api.getNodeExecutionInspection.mockReset();
  api.getNodeRuntimeValues.mockReset();
});

afterEach(async () => {
  await unmount();
  queryClient?.clear();
  queryClient = undefined;
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreProperty(window, "matchMedia", originalMatchMedia);
  restoreProperty(navigator, "clipboard", originalClipboard);
  restoreReactActEnvironment();
});

describe("Inspector presence", () => {
  it("cancels an old close when the selected target changes", async () => {
    const onExited = vi.fn();
    await render(React.createElement(PresenceHarness, { target: { id: "a" }, onExited }));

    await act(async () => presence!.close());
    expect(presence).toMatchObject({ exiting: true, layoutState: "closing" });

    await render(React.createElement(PresenceHarness, { target: { id: "b" }, onExited }));
    expect(presence).toMatchObject({ exiting: false, layoutState: "open" });
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => vi.runAllTimers());
    expect(onExited).not.toHaveBeenCalled();
    expect(presence).toMatchObject({ exiting: false, layoutState: "open" });
  });

  it("closes immediately when reduced motion is requested", async () => {
    const onExited = vi.fn();
    setReducedMotion(true);
    await render(React.createElement(PresenceHarness, { target: { id: "a" }, onExited }));

    await act(async () => presence!.close());

    expect(onExited).toHaveBeenCalledOnce();
    expect(presence?.exiting).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invoke the exit callback after unmount", async () => {
    const onExited = vi.fn();
    await render(React.createElement(PresenceHarness, { target: { id: "a" }, onExited }));
    await act(async () => presence!.close());
    expect(vi.getTimerCount()).toBe(1);

    await unmount();
    await act(async () => vi.runAllTimers());

    expect(onExited).not.toHaveBeenCalled();
  });
});

describe("Inspector primitives", () => {
  it("shows selected-node timing without run timing", async () => {
    const inspection: NodeInspection = {
      nodeKey: "task~abc",
      staticKind: "task",
      availableControls: [],
      timing: {
        startedAt: "2026-07-01T00:00:01.000Z",
        finishedAt: "2026-07-01T00:00:03.000Z",
        durationMs: 2_000,
      },
      artifacts: [],
    };

    await render(React.createElement(Inspector, {
      workspaceKey: "ws_current",
      runId: "run_1",
      target: "@1a2b3c4d5e6f",
      definition: undefined,
      agentProfile: undefined,
      inspection,
      loading: false,
    }));

    const timing = container.querySelector<HTMLElement>("[aria-label='Node timing']")!;
    expect([...timing.querySelectorAll("span")].map(label => label.textContent)).toEqual([
      "Node start",
      "Node duration",
    ]);
    expect(timing.textContent).toContain("2s");
    expect(container.textContent).not.toContain("Run start");
    expect(container.textContent).not.toContain("Run duration");
    expect([...container.querySelectorAll(".key-value > span")].map(label => label.textContent)).toEqual(["Node Key"]);
  });

  it("renders one semantic Agent Definition instead of Agent State plus raw JSON", async () => {
    await render(React.createElement(NodeDefinitionSection, {
      detail: {
        kind: "agent",
        agent: "observer",
        use: "codex",
        model: "opus",
        outputSchema: "{ ok: boolean }",
      },
      agentProfile: {
        kind: "agent_definition",
        use: "codex",
        model: "sonnet",
        config: { reasoning_effort: "high", model: "opus" },
      },
      runtimeModel: "fallback",
      lastObserved: "2s ago",
    }));

    expect([...container.querySelectorAll("h3")].map(heading => heading.textContent)).toEqual(["Agent Definition"]);
    expect([...container.querySelectorAll(".key-value")].map(row => row.textContent)).toEqual([
      "Nameobserver",
      "Agentcodex",
      "Effective modelopus",
      "Config · modelopus",
      "Config · reasoning_efforthigh",
      "Output schema{ ok: boolean }",
      "Last observed2s ago",
    ]);
    expect(container.textContent).not.toContain("Agent State");
    expect(container.querySelector(".json-viewer")).toBeNull();
  });

  it("identifies an authored Agent slot as unbound", async () => {
    await render(React.createElement(NodeDefinitionSection, {
      detail: {
        kind: "agent",
        agent: "reviewer",
        model: "gpt-5.6-luna",
        unbound: true,
      },
      agentProfile: {
        kind: "agent_slot",
        model: "gpt-5.6-luna",
      },
      runtimeModel: undefined,
      lastObserved: undefined,
    }));

    expect([...container.querySelectorAll(".key-value")].map(row => row.textContent)).toEqual([
      "Namereviewer",
      "BindingUnbound Agent slot",
      "Effective modelgpt-5.6-luna",
    ]);
  });

  it("keeps the node-kind discriminant out of non-Agent Definition JSON", async () => {
    await render(React.createElement(NodeDefinitionSection, {
      detail: { kind: "task", input: "input.topic", target: "inline" },
      agentProfile: undefined,
      runtimeModel: undefined,
      lastObserved: undefined,
    }));

    expect(container.querySelector("h3")?.textContent).toBe("Definition");
    expect(container.querySelector(".json-viewer")?.textContent).toContain("input");
    expect(container.querySelector(".json-viewer")?.textContent).not.toContain("kind");
  });

  it("renders expandable Runtime Values inline after Definition without adding a tab", async () => {
    const items = Array.from({ length: 100 }, (_, index) => `lane-${index}`);
    api.getNodeRuntimeValues.mockResolvedValue({
      available: true,
      values: { over: items, maxConcurrency: 4 },
    });
    const inspection: NodeInspection = {
      nodeKey: "lanes~abc",
      staticKind: "fanout",
      availableControls: [],
      input: { kind: "runtime", value: { release: true } },
      artifacts: [],
    };

    await render(React.createElement(
      QueryClientProvider,
      { client: queryClient! },
      React.createElement(Inspector, {
        workspaceKey: "ws_current",
        runId: "run_1",
        target: "@1a2b3c4d5e6f",
        definition: { kind: "fanout", over: "input.lanes", strategy: "all", maxConcurrency: "4" },
        agentProfile: undefined,
        inspection,
        loading: false,
      }),
    ));
    await waitForReact(() => expect(api.getNodeRuntimeValues).toHaveBeenCalledOnce());
    await waitForReact(() => expect([...container.querySelectorAll("h3")].map(heading => heading.textContent)).toEqual([
      "Runtime target",
      "Definition",
      "Runtime Values",
      "Input",
    ]));

    expect([...container.querySelectorAll(".inspector-tab")].map(tab => tab.textContent)).toEqual(["Overview"]);
    const runtimeValuesHeading = [...container.querySelectorAll("h3")].find(heading => heading.textContent === "Runtime Values")!;
    const runtimeValuesSection = runtimeValuesHeading.closest(".inspector-section")!;
    expect(runtimeValuesSection.textContent).toContain("over");
    expect(runtimeValuesSection.textContent).toContain("maxConcurrency");
    expect(runtimeValuesSection.textContent).not.toContain("lane-99");

    const over = [...runtimeValuesSection.querySelectorAll<HTMLElement>(".json-ink-label")]
      .find(label => label.textContent?.includes("over"))!;
    await act(async () => over.click());
    expect(runtimeValuesSection.textContent).toContain("lane-99");
  });

  it("uses each Artifact row as the single full-screen View action", async () => {
    api.getArtifactContent.mockResolvedValue({
      bytes: new TextEncoder().encode("complete artifact"),
      mediaType: "text/markdown",
      size: 17,
      fileName: "final.md",
    });
    const inspection: NodeInspection = {
      nodeKey: "report~abc",
      staticKind: "task",
      availableControls: [],
      artifacts: [{
        id: "artifact_1",
        path: "reports/final.md",
        size: 20,
        mediaType: "text/markdown",
      }],
    };

    await render(React.createElement(
      QueryClientProvider,
      { client: queryClient! },
      React.createElement(Inspector, {
        workspaceKey: "ws_current",
        runId: "run_1",
        target: "@1a2b3c4d5e6f",
        definition: undefined,
        agentProfile: undefined,
        inspection,
        loading: false,
      }),
    ));

    const artifactsTab = container.querySelector<HTMLButtonElement>("#inspector-tab-artifacts")!;
    await act(async () => artifactsTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    await waitForReact(() => expect(container.querySelector(".artifact-row")).not.toBeNull());
    const artifactRow = container.querySelector<HTMLButtonElement>(".artifact-row")!;
    expect(artifactRow.tagName).toBe("BUTTON");
    expect(artifactRow.getAttribute("aria-haspopup")).toBe("dialog");
    expect(artifactRow.getAttribute("aria-label"))
      .toBe("View artifact reports/final.md, text/markdown, 20 B");
    expect(artifactRow.querySelector("button")).toBeNull();
    expect(container.querySelector(".artifact-preview-region")).toBeNull();
    expect(container.querySelector(".artifact-select")).toBeNull();
    expect(container.querySelector(".artifact-full-view")).toBeNull();

    await act(async () => artifactRow.click());
    await waitForReact(() => expect(api.getArtifactContent).toHaveBeenCalledWith(
      "ws_current",
      "run_1",
      "artifact_1",
      expect.any(AbortSignal),
    ));
    expect(api.getArtifactPreview).not.toHaveBeenCalled();
    expect(document.querySelector(".artifact-viewer")).not.toBeNull();
    expect(document.querySelector(".dialog-overlay")).toBeNull();
  });

  it("opens View with a scoped abortable query and preserves Inspector context on close", async () => {
    let requestSignal: AbortSignal | undefined;
    api.getArtifactContent.mockImplementation((_workspaceKey, _runId, _artifactId, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const inspection: NodeInspection = {
      nodeKey: "report~abc",
      staticKind: "task",
      availableControls: [],
      artifacts: [{ id: "artifact_1", path: "reports/final.txt", size: 6, mediaType: "text/plain" }],
    };
    await render(React.createElement(
      QueryClientProvider,
      { client: queryClient! },
      React.createElement(Inspector, {
        workspaceKey: "ws_archive",
        runId: "run_1",
        target: "@1a2b3c4d5e6f",
        definition: undefined,
        agentProfile: undefined,
        inspection,
        loading: false,
      }),
    ));

    const artifactsTab = container.querySelector<HTMLButtonElement>("#inspector-tab-artifacts")!;
    await act(async () => artifactsTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    const trigger = container.querySelector<HTMLButtonElement>(".artifact-row")!;
    trigger.focus();
    await act(async () => trigger.click());

    await waitForReact(() => expect(api.getArtifactContent).toHaveBeenCalledOnce());
    expect(api.getArtifactContent).toHaveBeenCalledWith("ws_archive", "run_1", "artifact_1", expect.any(AbortSignal));
    expect(queryClient!.getQueryState(["artifact-content", "ws_archive", "run_1", "artifact_1"])).toBeDefined();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    await waitForReact(() => expect(requestSignal?.aborted).toBe(true));
    expect(queryClient!.getQueryData(["artifact-content", "ws_archive", "run_1", "artifact_1"])).toBeUndefined();
    expect(artifactsTab.getAttribute("data-state")).toBe("active");
    expect(document.activeElement).toBe(trigger);
    await act(async () => vi.advanceTimersByTime(120));
    expect(document.querySelector(".artifact-viewer")).toBeNull();
  });

  it("renders complete JSON as a Tree with an exact Raw source mode", async () => {
    const source = "{\"nested\":{\"done\":true}}\n";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:artifact-download");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await renderArtifactViewer(
      { id: "artifact_json", path: "reports/result.json", size: source.length, mediaType: "application/json" },
      source,
      "application/json",
    );

    await waitForReact(() => expect(document.querySelector(".artifact-viewer-tree")).not.toBeNull());
    expect(pressedMode()).toBe("Tree");
    expect(document.querySelector(".artifact-viewer-tree")?.textContent).toContain("nested");
    await clickViewerButton("Raw");
    expect(pressedMode()).toBe("Raw");
    expect(document.querySelector(".artifact-viewer-source")?.textContent).toBe(source);
    expect(document.querySelector("[aria-label='End of artifact']")?.textContent).toBe("End of artifact");

    await clickViewerButton("Copy source");
    expect(writeText).toHaveBeenCalledWith(source);
    await clickViewerButton("Download");
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) throw new TypeError("Download did not create a Blob.");
    expect(blob.size).toBe(new TextEncoder().encode(source).byteLength);
    expect(blob.type).toBe("application/json");
    expect(anchorClick).toHaveBeenCalledOnce();
    expect((anchorClick.mock.instances[0] as HTMLAnchorElement | undefined)?.download).toBe("result.json");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:artifact-download");
  });

  it("parses every NDJSON line into the default Tree", async () => {
    const source = "{\"record\":1}\n{\"record\":2}\n";
    await renderArtifactViewer(
      { id: "artifact_ndjson", path: "reports/result.ndjson", size: source.length, mediaType: "application/x-ndjson" },
      source,
      "application/x-ndjson",
    );

    await waitForReact(() => expect(document.querySelector(".artifact-viewer-tree")?.textContent).toContain("[{},{}]"));
    expect(pressedMode()).toBe("Tree");
    await clickViewerButton("Raw");
    expect(document.querySelector(".artifact-viewer-source")?.textContent).toBe(source);
  });

  it("falls back to the complete Raw source when JSON parsing fails", async () => {
    const source = "{ this is not json }";
    await renderArtifactViewer(
      { id: "artifact_bad_json", path: "bad.json", size: source.length, mediaType: "application/json" },
      source,
      "application/json",
    );

    await waitForReact(() => expect(document.querySelector(".artifact-viewer-source")).not.toBeNull());
    expect(document.querySelector(".artifact-viewer-notice")?.textContent).toContain("JSON parsing failed");
    expect(document.querySelector(".artifact-viewer-source")?.textContent).toBe(source);
    expect([...document.querySelectorAll(".artifact-viewer-mode")].map(button => button.textContent)).toEqual([]);
  });

  it("previews Markdown without embedded HTML and protects external links", async () => {
    const source = "# Report\n\n[External](https://example.com/report)\n\n<script>window.bad = true</script>";
    await renderArtifactViewer(
      { id: "artifact_md", path: "reports/final.md", size: source.length, mediaType: "text/markdown" },
      source,
      "text/markdown",
    );

    await waitForReact(() => expect(document.querySelector(".markdown-document.reading h1")?.textContent).toBe("Report"));
    const link = document.querySelector<HTMLAnchorElement>(".markdown-document.reading a")!;
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(document.querySelector(".markdown-document.reading script")).toBeNull();
    await clickViewerButton("Source");
    expect(document.querySelector(".artifact-viewer-source")?.textContent).toBe(source);
  });

  it("renders HTML in a script-only sandbox and exposes the complete source", async () => {
    const source = "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'sha256-test'\"></head><body><script>document.body.dataset.ready = 'yes'</script></body></html>";
    const onClose = await renderArtifactViewer(
      { id: "artifact_html", path: "reports/final.html", size: source.length, mediaType: "text/html" },
      source,
      "text/html",
    );

    await waitForReact(() => expect(document.querySelector(".artifact-viewer-frame")).not.toBeNull());
    const frame = document.querySelector<HTMLIFrameElement>(".artifact-viewer-frame")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.srcdoc).toContain("document.body.dataset.ready = 'yes'");
    expect(frame.srcdoc.indexOf("acpus:artifact-viewer:escape"))
      .toBeLessThan(frame.srcdoc.indexOf("Content-Security-Policy"));
    expect(document.querySelector("[aria-label='End of artifact']")).toBeNull();
    await clickViewerButton("Source");
    expect(document.querySelector(".artifact-viewer-source")?.textContent).toBe(source);
    expect(document.querySelector("[aria-label='End of artifact']")?.textContent).toBe("End of artifact");
    await clickViewerButton("Rendered");
    const renderedFrame = document.querySelector<HTMLIFrameElement>(".artifact-viewer-frame")!;
    const frameWindow = renderedFrame.contentWindow;
    if (!frameWindow) throw new TypeError("Rendered iframe did not expose a browsing context.");
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        data: "acpus:artifact-viewer:escape",
        source: frameWindow,
      }));
    });
    await act(async () => vi.advanceTimersByTime(120));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers retry after a complete-content failure and treats binary content as download-only", async () => {
    api.getArtifactContent
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce({ bytes: new Uint8Array([0, 1, 2]), mediaType: "application/octet-stream", size: 3, fileName: "data.bin" });
    await render(React.createElement(
      QueryClientProvider,
      { client: queryClient! },
      React.createElement(ArtifactViewer, {
        workspaceKey: "ws_current",
        runId: "run_1",
        artifact: { id: "artifact_binary", path: "data.bin", size: 3, mediaType: "application/octet-stream" },
        onClose: vi.fn(),
      }),
    ));

    await waitForReact(() => expect(document.querySelector(".artifact-viewer-state.error")?.textContent).toContain("registry unavailable"));
    await clickViewerButton("Retry");
    await waitForReact(() => expect(document.querySelector(".artifact-viewer-state.empty")?.textContent).toContain("not a supported text format"));
    expect(api.getArtifactContent).toHaveBeenCalledTimes(2);
    expect(document.querySelector<HTMLButtonElement>(".artifact-viewer-action")?.textContent).toContain("Download");
    expect(document.querySelector(".artifact-viewer-source")).toBeNull();
  });

  it("omits unavailable Observation-only execution sections", async () => {
    api.getNodeExecutionInspection.mockResolvedValue({
      available: true,
      summary: { status: "completed" },
      recentTools: [],
    });
    await render(React.createElement(
      QueryClientProvider,
      { client: queryClient! },
      React.createElement(AgentExecutionTab, { workspaceKey: "ws_current", runId: "run_1", target: "@1a2b3c4d5e6f", active: true }),
    ));
    await waitForReact(() => expect(container.querySelectorAll("h3")).toHaveLength(2));

    expect([...container.querySelectorAll("h3")].map(heading => heading.textContent)).toEqual([
      "Summary",
      "Recent observed tools",
    ]);
    expect(container.textContent).not.toContain("No context window data");
    expect(container.textContent).not.toContain("No token usage");
    expect(container.textContent).not.toContain("No streamed output");
  });

  it("keeps dialog, heading, key-value, Escape, and cleanup behavior", async () => {
    const onClose = vi.fn();
    await render(React.createElement(
      InspectorPanel,
      {
        title: "Node A",
        eyebrow: React.createElement(NodeKindBadge, { kind: "agent" }),
        subtitle: "jobs item[2]",
        status: React.createElement("span", { className: "status-pill completed" }, "completed"),
        onClose,
        children: React.createElement(InspectorSection, {
          title: "Identity",
          children: React.createElement(KeyValue, { label: "Node ID", value: "node-a" }),
        }),
      },
    ));

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    const titleBlock = dialog.querySelector<HTMLElement>(".inspector-card-title")!;
    const titleLine = dialog.querySelector<HTMLElement>(".inspector-card-title-line")!;
    const title = titleLine.querySelector<HTMLElement>(":scope > strong")!;
    const kind = titleLine.querySelector<HTMLElement>(".inspector-card-eyebrow")!;
    const status = titleLine.querySelector<HTMLElement>(".inspector-card-status")!;
    const subtitle = dialog.querySelector<HTMLElement>(".inspector-card-title > small")!;
    const keyValue = container.querySelector<HTMLElement>(".key-value")!;
    expect(dialog.getAttribute("aria-label")).toBe("Node A");
    expect(dialog.querySelector(".inspector-card-eyebrow .node-kind-badge.agent")?.textContent).toBe("AGENT");
    expect(dialog.querySelector(".inspector-card-eyebrow svg")).not.toBeNull();
    expect([...titleBlock.children]).toEqual([titleLine, subtitle]);
    expect([...titleLine.children]).toEqual([title, kind, status]);
    expect(title.textContent).toBe("Node A");
    expect(subtitle.textContent).toBe("jobs item[2]");
    expect(subtitle.title).toBe("jobs item[2]");
    expect(dialog.querySelector(".inspector-card-status .status-pill")?.textContent).toBe("completed");
    expect(dialog.querySelector(".inspector-card-body .status-pill")).toBeNull();
    expect(dialog.querySelector("h3")?.textContent).toBe("Identity");
    expect(keyValue.tabIndex).toBe(0);
    expect(keyValue.title).toBe("Node ID: node-a");
    expect(keyValue.getAttribute("aria-label")).toBe("Node ID: node-a");
    expect(keyValue.querySelector("span")?.textContent).toBe("Node ID");
    expect(keyValue.querySelector("strong")?.textContent).toBe("node-a");

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledOnce();
    await unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("copies exact pretty JSON and resets success feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const value = { zeta: 2, alpha: 1 };
    await render(React.createElement(JsonSection, { title: "Definition", value }));

    const button = container.querySelector<HTMLButtonElement>(".json-copy-button")!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(value, null, 2));
    expect(button.textContent).toContain("Copied");
    expect(container.querySelector(".json-viewer")).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(1_400));
    expect(button.textContent).toContain("Copy JSON");
  });

  it("keeps nested JSON collapsed until the operator asks for detail", async () => {
    await render(React.createElement(JsonSection, { title: "Payload", value: { outer: { inner: 1 } } }));

    expect(container.querySelector(".json-viewer")?.textContent).toContain("outer");
    expect(container.querySelector(".json-viewer")?.textContent).not.toContain("inner");
    expect(container.querySelector(".json-ink-container")).not.toBeNull();
    expect(container.querySelector(".json-ink-label")).not.toBeNull();
  });

  it("can expose nested authored definitions immediately", async () => {
    await render(React.createElement(JsonSection, {
      title: "Definition",
      value: { kind: "switch", cases: ["input.mode === auto"] },
      expandNested: true,
    }));

    expect(container.querySelector(".json-viewer")?.textContent).toContain("input.mode === auto");
  });

  it("shows and resets failed clipboard feedback", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await render(React.createElement(JsonSection, { title: "Definition", value: { ok: true } }));

    const button = container.querySelector<HTMLButtonElement>(".json-copy-button")!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(button.textContent).toContain("Copy failed");

    await act(async () => vi.advanceTimersByTime(1_800));
    expect(button.textContent).toContain("Copy JSON");
  });
});
