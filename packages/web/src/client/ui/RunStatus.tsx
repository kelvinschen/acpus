import Ban from "lucide-react/dist/esm/icons/ban.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/circle-check-big.js";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import Pause from "lucide-react/dist/esm/icons/pause.js";
import Radio from "lucide-react/dist/esm/icons/radio.js";
import XCircle from "lucide-react/dist/esm/icons/circle-x.js";
import { normalizeRuntimeStatus, runtimeStatusLabel } from "../../runtime-status.js";

export function RunStatusIndicator({ status }: { status: string }) {
  const display = normalizeRuntimeStatus(status);
  const active = display === "running" || display === "awaiting";
  return (
    <span className={`run-status-indicator ${display} ${active ? "live" : ""}`}>
      <span className="run-status-icon" aria-hidden="true">
        <RuntimeStatusIcon status={display} />
      </span>
      <span className="run-status-label">{runtimeStatusLabel(display)}</span>
    </span>
  );
}

export function RuntimeStatusIcon({ status, size = 13 }: { status: string; size?: number }) {
  const display = normalizeRuntimeStatus(status);
  if (display === "running") return <LoaderCircle size={size} strokeWidth={2} />;
  if (display === "awaiting") return <Radio size={size} strokeWidth={2} />;
  if (display === "paused") return <Pause size={size} strokeWidth={2} />;
  if (display === "completed") return <CheckCircle2 size={size} strokeWidth={2} />;
  if (display === "failed") return <XCircle size={size} strokeWidth={2} />;
  if (display === "canceled") return <Ban size={size} strokeWidth={2} />;
  return <Clock size={size} strokeWidth={2} />;
}

export function isTerminalRunStatus(status: string | undefined): boolean {
  const display = normalizeRuntimeStatus(status);
  return display === "completed" || display === "failed" || display === "canceled";
}
