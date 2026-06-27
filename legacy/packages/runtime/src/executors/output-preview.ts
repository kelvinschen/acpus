const DEFAULT_CAPTURED_OUTPUT_PREVIEW_CHARS = 2048;

export function schemaValidationError(
  validationMessage: string,
  rawOutput: string | undefined,
  output: unknown
): string {
  return `Output validation failed: ${validationMessage}; captured output preview: ${capturedOutputPreview(rawOutput, output)}`;
}

function capturedOutputPreview(rawOutput: string | undefined, output: unknown): string {
  const text = rawOutput ?? stringifyOutput(output);
  if (text.length <= DEFAULT_CAPTURED_OUTPUT_PREVIEW_CHARS) return text;
  return `${text.slice(0, DEFAULT_CAPTURED_OUTPUT_PREVIEW_CHARS)}... [truncated, ${text.length} chars total]`;
}

function stringifyOutput(output: unknown): string {
  try {
    const json = JSON.stringify(output);
    return json === undefined ? String(output) : json;
  } catch {
    return String(output);
  }
}
