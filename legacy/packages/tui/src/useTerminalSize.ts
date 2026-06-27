import { useEffect, useState } from "react";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Track the terminal size and update on resize. Ink can only erase a previous
 * frame when the frame fits within the terminal height; if a frame is taller
 * than the screen the old frame scrolls up and lingers. Components use this to
 * clip themselves to the available height.
 */
export function useTerminalSize(): TerminalSize {
  const read = (): TerminalSize => ({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24
  });
  const [size, setSize] = useState<TerminalSize>(read);

  useEffect(() => {
    const onResize = () => setSize(read());
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  return size;
}

/**
 * Compute a scrolling window [start, end) of `size` items that keeps the
 * selected index visible (roughly centered).
 */
export function windowSlice(total: number, selected: number, size: number): { start: number; end: number } {
  if (size <= 0 || total <= size) return { start: 0, end: total };
  let start = selected - Math.floor(size / 2);
  start = Math.max(0, Math.min(start, total - size));
  return { start, end: start + size };
}
