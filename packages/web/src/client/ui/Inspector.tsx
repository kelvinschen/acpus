import * as React from "react";
import { useEffect, useState } from "react";
import { collapseAllNested, darkStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import XCircle from "lucide-react/dist/esm/icons/circle-x.js";
import { Button } from "./shadcn/button.js";
import { Card } from "./shadcn/card.js";

export function InspectorPanel({
  title,
  eyebrow = "Inspector",
  subtitle,
  status,
  exiting = false,
  onClose,
  children,
}: {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  status?: React.ReactNode;
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
          <div className="inspector-card-title">
            <span className="inspector-card-eyebrow">{eyebrow}</span>
            <div className="inspector-card-title-line">
              <strong>{title}</strong>
              {status && <div className="inspector-card-status">{status}</div>}
            </div>
            {subtitle && <small>{subtitle}</small>}
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

export function JsonSection({ title, value, expandNested = false }: { title: string; value: unknown; expandNested?: boolean }) {
  return (
    <InspectorSection title={title} action={<JsonCopyButton value={value} />}>
      <JsonBlock value={value} expandNested={expandNested} />
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

export function JsonBlock({ value, expandNested = false }: { value: unknown; expandNested?: boolean }) {
  return (
    <div className="json-viewer">
      <JsonView data={jsonViewData(value)} shouldExpandNode={expandNested ? expandAllNodes : collapseAllNested} clickToExpandNode style={inkJsonStyles} />
    </div>
  );
}

const expandAllNodes = () => true;

const inkJsonStyles = {
  ...darkStyles,
  container: `${darkStyles.container} json-ink-container`,
  label: `${darkStyles.label} json-ink-label`,
  clickableLabel: `${darkStyles.clickableLabel} json-ink-label`,
  nullValue: `${darkStyles.nullValue} json-ink-null`,
  undefinedValue: `${darkStyles.undefinedValue} json-ink-null`,
  stringValue: `${darkStyles.stringValue} json-ink-string`,
  numberValue: `${darkStyles.numberValue} json-ink-number`,
  booleanValue: `${darkStyles.booleanValue} json-ink-boolean`,
  otherValue: `${darkStyles.otherValue} json-ink-other`,
  punctuation: `${darkStyles.punctuation} json-ink-punctuation`,
  collapseIcon: `${darkStyles.collapseIcon} json-ink-expander`,
  expandIcon: `${darkStyles.expandIcon} json-ink-expander`,
  collapsedContent: `${darkStyles.collapsedContent} json-ink-punctuation`,
};

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
