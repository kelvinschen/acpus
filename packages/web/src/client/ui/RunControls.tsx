import * as React from "react";
import { useState } from "react";
import Pause from "lucide-react/dist/esm/icons/pause.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Square from "lucide-react/dist/esm/icons/square.js";
import type { RunControlTarget, WebControlCommand } from "../api.js";
import { Button } from "./shadcn/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./shadcn/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./shadcn/select.js";

export function RunControls({
  disabled,
  status,
  selectedCancelTarget,
  selectedCancelLabel,
  canCancelRun,
  retryTargets,
  selectedRetryTarget,
  onSelectRetryTarget,
  onCommand,
}: {
  disabled: boolean;
  status: string | undefined;
  selectedCancelTarget: string | null | undefined;
  selectedCancelLabel: string | undefined;
  canCancelRun: boolean;
  retryTargets: RetryTarget[];
  selectedRetryTarget: string | undefined;
  onSelectRetryTarget(value: string): void;
  onCommand(input: Exclude<WebControlCommand, { type: "signal" }>): void;
}) {
  const controls = controlStateForRun(status, disabled, retryTargets, canCancelRun);
  const retryTarget = retryCommandTarget(retryTargets, selectedRetryTarget);
  const [pendingControl, setPendingControl] = useState<PendingControl | undefined>();
  const retryTargetLabel = retryTargets.find(target => target.value === retryTarget)?.label;

  return (
    <div className="control-strip">
      {retryTargets.length > 1 && controls.some(control => control.id === "retry") && (
        <Select
          value={selectedRetryTarget ?? retryTargets[0]?.value ?? ""}
          disabled={disabled}
          onValueChange={onSelectRetryTarget}
        >
          <SelectTrigger className="retry-target-select" aria-label="Retry target" title="Retry target">
            <SelectValue placeholder="Retry target" />
          </SelectTrigger>
          <SelectContent>
            {retryTargets.map(target => <SelectItem key={target.value} value={target.value}>{target.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {controls.map(control => {
        const command = commandForControl(control.id, retryTarget, selectedCancelTarget);
        const commandDisabled = (control.id === "retry" || control.id === "cancel") && !command;
        return (
          <IconButton
            key={control.id}
            label={control.label}
            title={control.title}
            tone={control.tone}
            icon={controlIcon(control.id)}
            disabled={control.disabled || commandDisabled}
            onClick={() => {
              if (!command) return;
              setPendingControl({
                control,
                command,
                targetLabel: control.id === "retry" ? retryTargetLabel : selectedCancelLabel,
                restoreFocus: document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
              });
            }}
          />
        );
      })}
      {pendingControl && (
        <ConfirmDialog
          confirmation={confirmationForControl(pendingControl.control.id, pendingControl.targetLabel)}
          restoreFocus={pendingControl.restoreFocus}
          onCancel={() => setPendingControl(undefined)}
          onConfirm={() => {
            onCommand(pendingControl.command);
            setPendingControl(undefined);
          }}
        />
      )}
    </div>
  );
}
export type RetryTarget = {
  value: string;
  label: string;
  kind: "frame" | "node";
};

export type RunControlId = "pause" | "resume" | "retry" | "cancel";

export type RunControlSpec = {
  id: RunControlId;
  label: string;
  tone: RunControlId;
  disabled: boolean;
  title: string;
};

type PendingControl = {
  control: RunControlSpec;
  command: Exclude<WebControlCommand, { type: "signal" }>;
  targetLabel: string | undefined;
  restoreFocus: HTMLElement | undefined;
};

export type ControlConfirmation = {
  title: string;
  detail: string;
  confirmLabel: string;
  tone: RunControlId;
};

export function retryTargetsForControls(targets: readonly RunControlTarget[]): RetryTarget[] {
  const baseLabels = targets.map(target => `${target.kind}: ${target.nodeId ?? target.target}`);
  const counts = new Map<string, number>();
  for (const label of baseLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return targets.map((target, index) => ({
    value: target.target,
    label: counts.get(baseLabels[index]!) === 1
      ? baseLabels[index]!
      : `${baseLabels[index]} (${target.target})`,
    kind: target.kind,
  }));
}

export function controlStateForRun(
  status: string | undefined,
  disabled: boolean,
  retryTargets: readonly RetryTarget[] = [],
  canCancelRun = false,
): RunControlSpec[] {
  if (status === "failed") {
    return [{
      id: "retry",
      label: "Retry",
      tone: "retry",
      disabled: disabled || retryTargets.length === 0,
      title: retryTargets.length === 0 ? "No failed retry target found. Use CLI for run-level retry." : "Retry failed target",
    }];
  }
  if (status === "paused") {
    return [
      controlSpec("resume", disabled),
      controlSpec("cancel", disabled || !canCancelRun),
    ];
  }
  if (status === "pending" || status === "running" || status === "awaiting") {
    return [
      controlSpec("pause", disabled),
      controlSpec("cancel", disabled || !canCancelRun),
    ];
  }
  return [
    controlSpec("pause", true),
    controlSpec("cancel", true),
  ];
}

export function retryCommandTarget(
  retryTargets: readonly RetryTarget[],
  selectedRetryTarget: string | undefined,
): string | undefined {
  if (retryTargets.length === 1) return retryTargets[0]!.value;
  return retryTargets.some(target => target.value === selectedRetryTarget) ? selectedRetryTarget : undefined;
}

export function commandForControl(
  controlId: RunControlId,
  retryTarget: string | undefined,
  selectedCancelTarget: string | null | undefined,
): Exclude<WebControlCommand, { type: "signal" }> | undefined {
  if (controlId === "retry") {
    return retryTarget?.trim() ? { type: "retry", target: retryTarget } : undefined;
  }
  if (controlId === "cancel" && selectedCancelTarget === null) return undefined;
  if (controlId === "cancel" && selectedCancelTarget === undefined) return { type: "cancel" };
  if (controlId === "cancel") {
    return selectedCancelTarget?.trim() ? { type: "cancel", target: selectedCancelTarget } : undefined;
  }
  return { type: controlId };
}

export function confirmationForControl(controlId: RunControlId, targetLabel: string | undefined): ControlConfirmation {
  if (controlId === "cancel") {
    return {
      title: targetLabel ? "Cancel selected target?" : "Cancel this run?",
      detail: targetLabel ? `Cancel target ${targetLabel}. This cannot be undone.` : "Cancel the current run. This cannot be undone.",
      confirmLabel: "Cancel",
      tone: "cancel",
    };
  }
  if (controlId === "retry") {
    return {
      title: "Retry failed target?",
      detail: targetLabel ? `Retry ${targetLabel}. The selected failed target will be re-driven.` : "Retry the selected failed target.",
      confirmLabel: "Retry",
      tone: "retry",
    };
  }
  if (controlId === "resume") {
    return {
      title: "Resume this run?",
      detail: "Resume the paused run and continue eligible work.",
      confirmLabel: "Resume",
      tone: "resume",
    };
  }
  return {
    title: "Pause this run?",
    detail: "Pause the run and stop active work as soon as the runtime can safely do so.",
    confirmLabel: "Pause",
    tone: "pause",
  };
}

function controlSpec(id: RunControlId, disabled: boolean): RunControlSpec {
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    tone: id,
    disabled,
    title: id[0]!.toUpperCase() + id.slice(1),
  };
}

function controlIcon(id: RunControlId): React.ReactNode {
  if (id === "pause") return <Pause size={16} />;
  if (id === "resume") return <Play size={16} />;
  if (id === "retry") return <RotateCcw size={16} />;
  return <Square size={16} />;
}

function ConfirmDialog({
  confirmation,
  restoreFocus,
  onCancel,
  onConfirm,
}: {
  confirmation: ControlConfirmation;
  restoreFocus: HTMLElement | undefined;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open onOpenChange={open => {
      if (!open) onCancel();
    }}>
      <DialogContent
        className={`confirm-dialog ${confirmation.tone}`}
        onCloseAutoFocus={event => {
          event.preventDefault();
          restoreFocus?.focus();
        }}
      >
        <DialogTitle>{confirmation.title}</DialogTitle>
        <DialogDescription>{confirmation.detail}</DialogDescription>
        <div className="confirm-actions">
          <Button type="button" variant="confirmSecondary" onClick={onCancel}>Back</Button>
          <Button type="button" variant="confirmPrimary" tone={confirmation.tone} onClick={onConfirm}>
            {confirmation.confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IconButton({
  icon,
  label,
  title,
  disabled,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  disabled: boolean;
  tone: RunControlId;
  onClick(): void;
}) {
  return (
    <Button variant="icon" tone={tone} disabled={disabled} onClick={onClick} title={title}>
      {icon}
      <span>{label}</span>
    </Button>
  );
}
