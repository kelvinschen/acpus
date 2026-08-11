import * as React from "react";
import { useEffect, useState } from "react";
import { collapseAllNested, defaultStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import Boxes from "lucide-react/dist/esm/icons/boxes.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import XCircle from "lucide-react/dist/esm/icons/circle-x.js";
import { Alert } from "./shadcn/alert.js";
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
  eyebrow?: React.ReactNode;
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
      <div role="dialog" aria-label={title}>
        <div className="inspector-card-head">
          <div className="inspector-card-title">
            <div className="inspector-card-title-line">
              <strong title={title}>{title}</strong>
              <div className="inspector-card-eyebrow">{eyebrow}</div>
              {status && <div className="inspector-card-status">{status}</div>}
            </div>
            {subtitle && <small title={subtitle}>{subtitle}</small>}
          </div>
          <Button variant="ghost" className="close-button" onClick={onClose} aria-label="Close inspector">
            <XCircle size={16} />
          </Button>
        </div>
        <div className="inspector-card-body">{children}</div>
      </div>
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
  ...defaultStyles,
  container: `${defaultStyles.container} json-ink-container`,
  label: `${defaultStyles.label} json-ink-label`,
  clickableLabel: `${defaultStyles.clickableLabel} json-ink-label`,
  nullValue: `${defaultStyles.nullValue} json-ink-null`,
  undefinedValue: `${defaultStyles.undefinedValue} json-ink-null`,
  stringValue: `${defaultStyles.stringValue} json-ink-string`,
  numberValue: `${defaultStyles.numberValue} json-ink-number`,
  booleanValue: `${defaultStyles.booleanValue} json-ink-boolean`,
  otherValue: `${defaultStyles.otherValue} json-ink-other`,
  punctuation: `${defaultStyles.punctuation} json-ink-punctuation`,
  collapseIcon: `${defaultStyles.collapseIcon} json-ink-expander`,
  expandIcon: `${defaultStyles.expandIcon} json-ink-expander`,
  collapsedContent: `${defaultStyles.collapsedContent} json-ink-punctuation`,
};

function jsonViewData(value: unknown): object | unknown[] {
  return value !== null && typeof value === "object" ? value as object | unknown[] : { value };
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="key-value" role="group" tabIndex={0} title={`${label}: ${value}`} aria-label={`${label}: ${value}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function StateBlock({ tone, title, detail }: { tone: "loading" | "empty" | "error"; title: string; detail?: string }) {
  const icon = tone === "loading"
    ? <LoaderCircle size={16} />
    : tone === "error"
      ? <CircleAlert size={16} />
      : <Boxes size={16} />;
  return (
    <Alert
      className={`state-block ${tone}`}
      role={tone === "error" ? "alert" : tone === "loading" ? "status" : undefined}
      aria-busy={tone === "loading" ? true : undefined}
    >
      <span className="state-block-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
        {tone === "loading" && (
          <div className="state-skeleton" aria-hidden="true">
            <span className="state-skeleton-line" />
            <span className="state-skeleton-line short" />
          </div>
        )}
      </div>
    </Alert>
  );
}
