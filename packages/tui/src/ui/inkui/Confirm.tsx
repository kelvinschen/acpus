import React, { useState } from "react";
import { Text, useInput } from "ink";
import { acpusInkUiTheme, type InkUiTheme } from "./theme.js";

export function Confirm({
  message,
  defaultValue = false,
  onConfirm,
  onCancel,
  theme = acpusInkUiTheme
}: {
  message: string;
  defaultValue?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
  theme?: InkUiTheme;
}): React.ReactElement {
  const [resolved, setResolved] = useState<"confirmed" | "cancelled" | undefined>(undefined);

  useInput((input, key) => {
    if (resolved) return;
    if (input === "y" || input === "Y") {
      setResolved("confirmed");
      onConfirm();
      return;
    }
    if (input === "n" || input === "N" || key.escape) {
      setResolved("cancelled");
      onCancel?.();
      return;
    }
    if (key.return) {
      const next = defaultValue ? "confirmed" : "cancelled";
      setResolved(next);
      if (defaultValue) onConfirm();
      else onCancel?.();
    }
  });

  const suffix = confirmSuffix(defaultValue);
  const answer = resolved === "confirmed" ? " yes" : resolved === "cancelled" ? " no" : " █";

  return (
    <Text>
      <Text color={theme.colors.primary}>?</Text>
      <Text> {message} </Text>
      <Text color={theme.colors.muted}>{suffix}</Text>
      <Text color={resolved === "confirmed" ? theme.colors.success : resolved === "cancelled" ? theme.colors.muted : theme.colors.primary}>
        {answer}
      </Text>
    </Text>
  );
}

export function confirmSuffix(defaultValue: boolean): string {
  return defaultValue ? "(Y/n)" : "(y/N)";
}
