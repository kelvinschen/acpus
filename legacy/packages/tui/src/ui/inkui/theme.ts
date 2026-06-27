export interface InkUiTheme {
  colors: {
    primary: string;
    secondary: string;
    success: string;
    warning: string;
    error: string;
    info: string;
    muted: string;
    text: string;
    textInverse: string;
    border: string;
    focus: string;
    selection: string;
  };
}

export const acpusInkUiTheme: InkUiTheme = {
  colors: {
    primary: "cyan",
    secondary: "magenta",
    success: "green",
    warning: "yellow",
    error: "red",
    info: "blue",
    muted: "gray",
    text: "white",
    textInverse: "black",
    border: "gray",
    focus: "cyan",
    selection: "cyan"
  }
};

export function clampInline(s: string, width: number): string {
  if (width <= 0) return "";
  return s.length > width ? s.slice(0, Math.max(0, width - 1)) + "…" : s;
}

export function wrapText(s: string, width: number): string[] {
  const cols = Math.max(1, width);
  if (s.length === 0) return [""];
  const lines: string[] = [];
  for (const sourceLine of s.split("\n")) {
    let rest = sourceLine;
    if (rest.length === 0) {
      lines.push("");
      continue;
    }
    while (rest.length > cols) {
      const window = rest.slice(0, cols + 1);
      const slash = window.lastIndexOf("/");
      const space = window.lastIndexOf(" ");
      const breakAt = Math.max(slash, space);
      if (breakAt > Math.floor(cols * 0.4)) {
        lines.push(rest.slice(0, breakAt + 1));
        rest = rest.slice(breakAt + 1);
      } else {
        lines.push(rest.slice(0, cols));
        rest = rest.slice(cols);
      }
    }
    lines.push(rest);
  }
  return lines;
}
