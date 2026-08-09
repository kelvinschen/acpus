import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Check from "lucide-react/dist/esm/icons/check.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { getArtifactContent } from "../api.js";
import { JsonBlock } from "./Inspector.js";
import { MarkdownDocument } from "./MarkdownDocument.js";
import { Button } from "./shadcn/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./shadcn/dialog.js";

export type ArtifactViewerArtifact = {
  id: string;
  path: string;
  size: number;
  mediaType?: string;
};

type ArtifactKind = "json" | "markdown" | "html" | "text" | "binary";
type ArtifactMode = "tree" | "raw" | "preview" | "source" | "rendered";

export function ArtifactViewer({
  workspaceKey,
  runId,
  artifact,
  restoreFocus,
  onClose,
}: {
  workspaceKey: string;
  runId: string;
  artifact: ArtifactViewerArtifact;
  restoreFocus?: HTMLElement;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(true);
  const [requestedMode, setRequestedMode] = React.useState<ArtifactMode>();
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");
  const closeTimer = React.useRef<number | undefined>(undefined);
  const queryKey = React.useMemo(
    () => ["artifact-content", workspaceKey, runId, artifact.id] as const,
    [artifact.id, runId, workspaceKey],
  );
  const content = useQuery({
    queryKey,
    queryFn: ({ signal }) => getArtifactContent(workspaceKey, runId, artifact.id, signal),
    enabled: open,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });

  React.useEffect(() => () => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
    void queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.removeQueries({ queryKey, exact: true });
  }, [queryClient, queryKey]);

  const loaded = content.data;
  const mediaType = loaded?.mediaType ?? artifact.mediaType ?? "application/octet-stream";
  const kind = artifactKind(mediaType);
  const text = React.useMemo(
    () => loaded && kind !== "binary" ? new TextDecoder().decode(loaded.bytes) : undefined,
    [kind, loaded],
  );
  const parsedJson = React.useMemo(
    () => kind === "json" && text !== undefined ? tryParseArtifactJson(text) : undefined,
    [kind, text],
  );
  const modes = artifactModes(kind, parsedJson?.ok ?? false);
  const mode = requestedMode && modes.includes(requestedMode) ? requestedMode : modes[0];
  const fileName = loaded?.fileName ?? artifactBaseName(artifact.path);

  const close = React.useCallback(() => {
    if (!open) return;
    setOpen(false);
    void queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.removeQueries({ queryKey, exact: true });
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    closeTimer.current = window.setTimeout(onClose, reducedMotion ? 0 : 120);
  }, [onClose, open, queryClient, queryKey]);

  const copySource = async () => {
    if (text === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const download = () => {
    if (!loaded) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(loaded.bytes)], { type: loaded.mediaType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = loaded.fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={nextOpen => {
      if (!nextOpen) close();
    }}>
      <DialogContent
        className="artifact-viewer"
        overlayClassName="artifact-viewer-overlay"
        onCloseAutoFocus={event => {
          event.preventDefault();
          restoreFocus?.focus();
        }}
        onEscapeKeyDown={event => {
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <header className="artifact-viewer-header">
          <div className="artifact-viewer-heading">
            <span className="artifact-viewer-eyebrow">Artifact</span>
            <DialogTitle title={fileName}>{fileName}</DialogTitle>
            <DialogDescription title={artifact.path}>{artifact.path}</DialogDescription>
          </div>
          <dl className="artifact-viewer-meta" aria-label="Artifact metadata">
            <div>
              <dt>Type</dt>
              <dd>{mediaType}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatArtifactSize(loaded?.size ?? artifact.size)}</dd>
            </div>
          </dl>
          <div className="artifact-viewer-actions">
            <div className="artifact-viewer-action-strip">
              {modes.length > 1 && (
                <div className="artifact-viewer-modes" role="group" aria-label="View mode">
                  {modes.map(candidate => (
                    <Button
                      key={candidate}
                      type="button"
                      variant="ghost"
                      className="artifact-viewer-mode"
                      aria-pressed={mode === candidate}
                      onClick={() => setRequestedMode(candidate)}
                    >
                      {modeLabel(candidate)}
                    </Button>
                  ))}
                </div>
              )}
              {text !== undefined && (
                <Button type="button" variant="ghost" className="artifact-viewer-action" onClick={() => void copySource()}>
                  {copyState === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                  {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy source"}
                </Button>
              )}
              <Button type="button" variant="ghost" className="artifact-viewer-action" disabled={!loaded} onClick={download}>
                <Download size={16} aria-hidden="true" />
                Download
              </Button>
            </div>
            <Button type="button" variant="ghost" className="artifact-viewer-close" aria-label="Close full view" title="Close" onClick={close}>
              <X size={18} aria-hidden="true" />
            </Button>
          </div>
        </header>

        <main className="artifact-viewer-body">
          {content.isLoading ? (
            <ViewerState tone="loading" title="Loading complete artifact" />
          ) : content.error ? (
            <ViewerState
              tone="error"
              title="Artifact could not be loaded"
              detail={content.error instanceof Error ? content.error.message : String(content.error)}
              action={(
                <Button type="button" variant="ghost" className="artifact-viewer-retry" onClick={() => void content.refetch()}>
                  <RotateCcw size={16} aria-hidden="true" />
                  Retry
                </Button>
              )}
            />
          ) : loaded && kind === "binary" ? (
            <ViewerState
              tone="empty"
              title="This artifact is not a supported text format"
              detail="Use Download to open the complete file in another application."
            />
          ) : text !== undefined && kind !== "binary" ? (
            <ArtifactViewerDocument kind={kind} mode={mode} text={text} parsedJson={parsedJson} onEscape={close} />
          ) : null}
        </main>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactViewerDocument({
  kind,
  mode,
  text,
  parsedJson,
  onEscape,
}: {
  kind: Exclude<ArtifactKind, "binary">;
  mode: ArtifactMode | undefined;
  text: string;
  parsedJson: ReturnType<typeof tryParseArtifactJson> | undefined;
  onEscape(): void;
}) {
  let content: React.ReactNode;
  if (kind === "json" && mode === "tree" && parsedJson?.ok) {
    content = <div className="artifact-viewer-tree"><JsonBlock value={parsedJson.value} /></div>;
  } else if (kind === "markdown" && mode === "preview") {
    content = <ArtifactMarkdown value={text} />;
  } else if (kind === "html" && mode === "rendered") {
    content = <ArtifactHtmlFrame value={text} onEscape={onEscape} />;
  } else {
    content = <pre className="artifact-viewer-source">{text}</pre>;
  }
  return (
    <div className={`artifact-viewer-document ${kind} ${mode ?? "source"}`}>
      {kind === "json" && parsedJson && !parsedJson.ok && (
        <div className="artifact-viewer-notice" role="status">JSON parsing failed. Showing the complete source.</div>
      )}
      {content}
      {(kind !== "html" || mode !== "rendered") && (
        <div className="artifact-viewer-end" role="separator" aria-label="End of artifact">End of artifact</div>
      )}
    </div>
  );
}

const artifactViewerEscapeMessage = "acpus:artifact-viewer:escape";

function ArtifactHtmlFrame({ value, onEscape }: { value: string; onEscape(): void }) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const srcDoc = React.useMemo(() => htmlWithEscapeBridge(value), [value]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === frameRef.current?.contentWindow && event.data === artifactViewerEscapeMessage) {
        onEscape();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onEscape]);

  return (
    <iframe
      ref={frameRef}
      className="artifact-viewer-frame"
      title="Rendered HTML artifact"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
    />
  );
}

function htmlWithEscapeBridge(value: string): string {
  const document = new DOMParser().parseFromString(value, "text/html");
  const bridge = document.createElement("script");
  bridge.textContent = `addEventListener("keydown",event=>{if(event.key==="Escape"){event.preventDefault();parent.postMessage("${artifactViewerEscapeMessage}","*")}},true)`;
  document.head.prepend(bridge);
  const doctype = document.doctype ? `<!doctype ${document.doctype.name}>` : "";
  return `${doctype}${document.documentElement.outerHTML}`;
}

function ArtifactMarkdown({ value }: { value: string }) {
  return <MarkdownDocument value={value} variant="reading" />;
}

function ViewerState({
  tone,
  title,
  detail,
  action,
}: {
  tone: "loading" | "error" | "empty";
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={`artifact-viewer-state ${tone}`} role={tone === "error" ? "alert" : "status"} aria-busy={tone === "loading" || undefined}>
      {tone === "loading" && <LoaderCircle size={22} aria-hidden="true" />}
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}

function artifactKind(mediaType: string): ArtifactKind {
  const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (normalized.includes("json") || normalized.includes("ndjson")) return "json";
  if (normalized === "text/markdown" || normalized === "text/x-markdown") return "markdown";
  if (normalized === "text/html") return "html";
  if (normalized.startsWith("text/") || /(?:xml|yaml|javascript|typescript|toml)$/.test(normalized)) return "text";
  return "binary";
}

function artifactModes(kind: ArtifactKind, validJson: boolean): ArtifactMode[] {
  if (kind === "json") return validJson ? ["tree", "raw"] : ["raw"];
  if (kind === "markdown") return ["preview", "source"];
  if (kind === "html") return ["rendered", "source"];
  if (kind === "text") return ["source"];
  return [];
}

function modeLabel(mode: ArtifactMode): string {
  if (mode === "tree") return "Tree";
  if (mode === "raw") return "Raw";
  if (mode === "preview") return "Preview";
  if (mode === "rendered") return "Rendered";
  return "Source";
}

function tryParseArtifactJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) return { ok: false };
    try {
      return { ok: true, value: lines.map(line => JSON.parse(line) as unknown) };
    } catch {
      return { ok: false };
    }
  }
}

function artifactBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "artifact";
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
