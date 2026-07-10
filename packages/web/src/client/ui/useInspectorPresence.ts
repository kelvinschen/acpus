import { useEffect, useRef, useState } from "react";

const inspectorExitMs = 220;
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

export function useInspectorPresence<T>(target: T | undefined, onExited: () => void): {
  exiting: boolean;
  layoutState: "closed" | "open" | "closing";
  close(): void;
} {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setExiting(false);
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, [target]);

  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);

  const close = () => {
    if (target === undefined || exiting) return;
    if (window.matchMedia(reducedMotionQuery).matches) {
      setExiting(false);
      onExited();
      return;
    }
    setExiting(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      setExiting(false);
      onExited();
    }, inspectorExitMs);
  };

  return { exiting, layoutState: target === undefined ? "closed" : exiting ? "closing" : "open", close };
}
