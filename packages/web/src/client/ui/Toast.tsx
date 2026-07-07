import { useCallback, useEffect, useRef, useState } from "react";
import CheckCircle2 from "lucide-react/dist/esm/icons/circle-check-big.js";
import X from "lucide-react/dist/esm/icons/x.js";
import XCircle from "lucide-react/dist/esm/icons/circle-x.js";
import { Button } from "./shadcn/button.js";

export type Toast = { id: string; tone: "success" | "error"; title: string; detail?: string };

const AUTO_DISMISS_MS = 4_000;

// Minimal toast store: push appends a toast and schedules its auto-dismissal; timers are cleared
// on unmount so no state updates fire after teardown.
export function useToasts(): {
  toasts: Toast[];
  push(toast: Omit<Toast, "id">): void;
  dismiss(id: string): void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts(current => current.filter(toast => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    setToasts(current => [...current, { ...toast, id }]);
    timers.current.set(id, setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

export function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: string): void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast ${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
          aria-live={toast.tone === "error" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          {toast.tone === "success" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <div className="toast-body">
            <strong>{toast.title}</strong>
            {toast.detail && <span>{toast.detail}</span>}
          </div>
          <Button variant="ghost" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
            <X size={14} />
          </Button>
        </div>
      ))}
    </div>
  );
}
