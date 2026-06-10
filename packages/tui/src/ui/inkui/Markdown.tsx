import React from "react";
import { Box, Text } from "ink";
import { acpusInkUiTheme, wrapText, type InkUiTheme } from "./theme.js";

export function Markdown({
  content,
  width,
  theme = acpusInkUiTheme
}: {
  content: string;
  width: number;
  theme?: InkUiTheme;
}): React.ReactElement {
  return <Box flexDirection="column">{markdownRows(content, width, theme)}</Box>;
}

export function markdownRows(content: string, width: number, theme: InkUiTheme = acpusInkUiTheme): React.ReactElement[] {
  const rows: React.ReactElement[] = [];
  const lines = content.split("\n");
  let inCode = false;
  let codeLang = "";

  lines.forEach((line, index) => {
    if (line.startsWith("```")) {
      inCode = !inCode;
      codeLang = inCode ? line.slice(3).trim() : "";
      rows.push(
        <Text key={`fence-${index}`} color={theme.colors.muted}>
          {inCode ? `┌─ ${codeLang || "code"}` : "└─"}
        </Text>
      );
      return;
    }

    if (inCode) {
      for (const [chunkIndex, chunk] of wrapText(line, Math.max(1, width - 2)).entries()) {
        rows.push(
          <Text key={`code-${index}-${chunkIndex}`} color={theme.colors.text}>
            │ {chunk}
          </Text>
        );
      }
      return;
    }

    if (line.startsWith("# ")) {
      rows.push(<Text key={`h1-${index}`} bold color={theme.colors.primary}>{line.slice(2)}</Text>);
      return;
    }
    if (line.startsWith("## ")) {
      rows.push(<Text key={`h2-${index}`} bold color={theme.colors.secondary}>{line.slice(3)}</Text>);
      return;
    }
    if (line.startsWith("### ")) {
      rows.push(<Text key={`h3-${index}`} bold>{line.slice(4)}</Text>);
      return;
    }
    if (line.startsWith("> ")) {
      for (const [chunkIndex, chunk] of wrapText(line.slice(2), Math.max(1, width - 2)).entries()) {
        rows.push(<Text key={`quote-${index}-${chunkIndex}`} color={theme.colors.muted}>│ {chunk}</Text>);
      }
      return;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      for (const [i, chunk] of wrapText(line.slice(2), Math.max(1, width - 4)).entries()) {
        rows.push(
            <Text key={`ul-${index}-${i}`}>
              <Text color={theme.colors.primary}>{i === 0 ? "  • " : "    "}</Text>
            {renderInlineParts(chunk, theme, `ul-${index}-${i}`)}
          </Text>
        );
      }
      return;
    }
    const ordered = line.match(/^(\s*)(\d+)\.\s(.*)$/);
    if (ordered) {
      const prefix = `${ordered[1]}${ordered[2]}. `;
      for (const [i, chunk] of wrapText(ordered[3], Math.max(1, width - prefix.length)).entries()) {
        rows.push(
          <Text key={`ol-${index}-${i}`}>
            <Text color={theme.colors.primary}>{i === 0 ? prefix : " ".repeat(prefix.length)}</Text>
            {renderInlineParts(chunk, theme, `ol-${index}-${i}`)}
          </Text>
        );
      }
      return;
    }
    if (line.trim() === "") {
      rows.push(<Text key={`blank-${index}`}> </Text>);
      return;
    }
    for (const [i, chunk] of wrapText(line, width).entries()) {
        rows.push(<Text key={`p-${index}-${i}`}>{renderInlineParts(chunk, theme, `p-${index}-${i}`)}</Text>);
    }
  });

  return rows.length > 0 ? rows : [<Text key="empty" color={theme.colors.muted}>No prompt.</Text>];
}

function renderInlineParts(line: string, theme: InkUiTheme, keyPrefix = "inline"): React.ReactNode[] {
  const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    const key = `${keyPrefix}:${part}:${index}`;
    if (part.startsWith("`") && part.endsWith("`")) {
      return <Text key={key} color={theme.colors.info} inverse>{part.slice(1, -1)}</Text>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <Text key={key} bold>{part.slice(2, -2)}</Text>;
    }
    return part;
  });
}
