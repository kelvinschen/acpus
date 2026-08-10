import Database from "lucide-react/dist/esm/icons/database.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import type { RuntimeStoreStatus } from "../api.js";
import { Alert } from "./shadcn/alert.js";
import { Button } from "./shadcn/button.js";

export function RuntimeStoreNotice({
  status,
  loadError,
  repairError,
  repairing,
  onFix,
  onRetry,
}: {
  status: RuntimeStoreStatus | undefined;
  loadError: unknown;
  repairError: unknown;
  repairing: boolean;
  onFix(): void;
  onRetry(): void;
}) {
  if (!loadError && !repairError && (status === undefined || status.state === "ready")) return null;

  const error = repairError ?? loadError;
  const unavailable = status?.state === "unavailable";
  const message = errorMessage(error) ?? (status?.state === "ready" ? undefined : status?.message);
  const canFix = status?.state === "needs-fix" && !loadError;

  return (
    <Alert className={`runtime-store-notice ${unavailable || error ? "error" : ""}`} role={unavailable || error ? "alert" : "status"}>
      <Database size={18} aria-hidden="true" />
      <div className="runtime-store-notice-copy">
        <strong>{repairing ? "Fixing Runtime" : unavailable ? "Runtime unavailable" : error ? "Runtime fix failed" : "Runtime needs attention"}</strong>
        {message && <span>{message}</span>}
      </div>
      <div className="runtime-store-notice-actions">
        {canFix && (
          <Button type="button" className="primary-button" disabled={repairing} onClick={onFix}>
            {repairing ? "Fixing…" : repairError ? "Retry" : "Fix"}
          </Button>
        )}
        {Boolean(loadError) && (
          <Button type="button" variant="ghost" onClick={onRetry}>
            <RotateCcw size={15} aria-hidden="true" />
            Retry
          </Button>
        )}
      </div>
    </Alert>
  );
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error && error.message.length > 0 ? error.message : undefined;
}
