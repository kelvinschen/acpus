import React from "react";
import { Box, Text } from "ink";
import { acpusInkUiTheme, type InkUiTheme } from "./theme.js";

export interface ScrollAreaMetrics {
  start: number;
  end: number;
  moreAbove: number;
  moreBelow: number;
  maxOffset: number;
}

export interface ScrollbarMetrics {
  show: boolean;
  thumbSize: number;
  thumbPos: number;
}

export interface ScrollAreaProps {
  height: number;
  width?: number;
  offset?: number;
  scrollbar?: boolean;
  scrollbarChar?: string;
  trackChar?: string;
  theme?: InkUiTheme;
  empty?: React.ReactNode;
  children: React.ReactNode;
}

export function scrollAreaMetrics(total: number, height: number, offset = 0): ScrollAreaMetrics {
  const visibleRows = Math.max(1, height);
  const maxOffset = Math.max(0, total - visibleRows);
  const start = Math.max(0, Math.min(offset, maxOffset));
  const end = Math.min(total, start + visibleRows);
  return { start, end, moreAbove: start, moreBelow: total - end, maxOffset };
}

export function scrollbarMetrics(total: number, height: number, offset = 0): ScrollbarMetrics {
  const rows = Math.max(0, total);
  const visibleRows = Math.max(1, height);
  if (rows <= visibleRows) return { show: false, thumbSize: visibleRows, thumbPos: 0 };
  const metrics = scrollAreaMetrics(rows, visibleRows, offset);
  const proportional = Math.floor((visibleRows / rows) * visibleRows);
  const thumbSize = Math.max(1, Math.min(visibleRows, proportional));
  const maxThumbPos = Math.max(0, visibleRows - thumbSize);
  const thumbPos = metrics.maxOffset > 0
    ? Math.min(maxThumbPos, Math.floor((metrics.start / metrics.maxOffset) * maxThumbPos))
    : 0;
  return { show: true, thumbSize, thumbPos };
}

export function ScrollArea({
  height,
  width,
  offset = 0,
  scrollbar = true,
  scrollbarChar = "█",
  trackChar = "░",
  theme = acpusInkUiTheme,
  empty,
  children
}: ScrollAreaProps): React.ReactElement {
  const rows = React.Children.toArray(children);
  const metrics = scrollAreaMetrics(rows.length, height, offset);
  const visible = rows.slice(metrics.start, metrics.end);
  const bar = scrollbarMetrics(rows.length, height, offset);
  const showScrollbar = scrollbar && bar.show;
  const contentWidth = width === undefined ? undefined : Math.max(1, width - (showScrollbar ? 1 : 0));

  return (
    <Box flexDirection="row" height={height} width={width} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} width={contentWidth}>
        {rows.length === 0 ? empty : visible}
      </Box>
      {showScrollbar ? (
        <Box flexDirection="column" width={1}>
          {Array.from({ length: height }, (_, i) => {
            const isThumb = i >= bar.thumbPos && i < bar.thumbPos + bar.thumbSize;
            return (
              <Text key={i} color={isThumb ? theme.colors.primary : theme.colors.muted}>
                {isThumb ? scrollbarChar : trackChar}
              </Text>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
}
