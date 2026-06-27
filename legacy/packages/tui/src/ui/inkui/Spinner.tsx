import React, { useEffect, useRef, useState } from "react";
import { Text } from "ink";
import { acpusInkUiTheme, type InkUiTheme } from "./theme.js";

const FRAMES = {
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  line: ["-", "\\", "|", "/"],
  arc: ["◜", "◠", "◝", "◞", "◡", "◟"],
  bounce: ["⠁", "⠂", "⠄", "⠂"]
} as const;

export type SpinnerType = keyof typeof FRAMES;

export function spinnerFrame(type: SpinnerType, frame: number, active: boolean): string {
  if (!active) return "■";
  const frames = FRAMES[type];
  return frames[Math.max(0, frame) % frames.length];
}

export function Spinner({
  label = "",
  type = "dots",
  interval = 80,
  active = true,
  theme = acpusInkUiTheme
}: {
  label?: string;
  type?: SpinnerType;
  interval?: number;
  active?: boolean;
  theme?: InkUiTheme;
}): React.ReactElement {
  const frames = FRAMES[type];
  const [frame, setFrame] = useState(0);
  const wasActiveRef = useRef(active);

  useEffect(() => {
    if (active && !wasActiveRef.current) setFrame(0);
    wasActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, interval);
    return () => clearInterval(timer);
  }, [active, interval, type]);

  return (
    <Text>
      <Text color={active ? theme.colors.primary : theme.colors.muted}>{spinnerFrame(type, frame, active)}</Text>
      {active && label ? ` ${label}` : ""}
    </Text>
  );
}
