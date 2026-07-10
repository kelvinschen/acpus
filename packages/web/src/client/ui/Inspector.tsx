import * as React from "react";
import { useEffect, useState } from "react";
import { allExpanded, defaultStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import XCircle from "lucide-react/dist/esm/icons/circle-x.js";
import { Button } from "./shadcn/button.js";
import { Card } from "./shadcn/card.js";

export function InspectorPanel({
  title,
  exiting = false,
  onClose,
  children,
}: {
  title: string;
  exiting?: boolean;
  onClose(): void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <Card asChild className={`inspector-card ${exiting ? "exiting" : ""}`}>
      <aside role="dialog" aria-label={title}>
        <div className="inspector-card-head">
          <div>
            <span>Inspector</span>
            <strong>{title}</strong>
          </div>
          <Button variant="ghost" className="close-button" onClick={onClose} aria-label="Close inspector">
            <XCircle size={16} />
          </Button>
        </div>
        <div className="inspector-card-body">{children}</div>
      </aside>
    </Card>
  );
}

export function InspectorSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="inspector-section">
      <div className="inspector-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      <div className="inspector-section-body">{children}</div>
    </section>
  );
}

export function JsonSection({ title, value }: { title: string; value: unknown }) {
  return (
    <InspectorSection title={title} action={<JsonCopyButton value={value} />}>
      <JsonBlock value={value} />
    </InspectorSection>
  );
}

function JsonCopyButton({ value }: { value: unknown }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="ghost"
      className={`json-copy-button ${state}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
          setState("copied");
          window.setTimeout(() => setState("idle"), 1_400);
        } catch {
          setState("failed");
          window.setTimeout(() => setState("idle"), 1_800);
        }
      }}
    >
      <Copy size={13} />
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy JSON"}
    </Button>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <div className="json-viewer">
      <JsonView data={jsonViewData(value)} shouldExpandNode={allExpanded} style={defaultStyles} />
    </div>
  );
}

function jsonViewData(value: unknown): object | unknown[] {
  return value !== null && typeof value === "object" ? value as object | unknown[] : { value };
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="key-value" tabIndex={0} title={`${label}: ${value}`} aria-label={`${label}: ${value}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
