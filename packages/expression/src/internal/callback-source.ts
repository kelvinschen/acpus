export function callbackSourceIssue(source: string, expectedParams: number): string | undefined {
  const text = source.trim();
  const arrow = findTopLevelArrow(text);
  if (arrow < 0) return "callback source must be an arrow function.";
  const params = text.slice(0, arrow).trim();
  const body = text.slice(arrow + 2).trim();
  if (params.startsWith("async") && /\basync\b/.test(params.slice(0, 5))) return "callback source must be synchronous.";
  if (body.length === 0) return "callback source must have an expression body.";
  if (stripLeadingTrivia(body).startsWith("{")) return "callback source must be an expression-body arrow, not a block body.";
  const actualParams = parameterCount(params);
  if (actualParams !== expectedParams) return `callback source expected ${expectedParams} parameter${expectedParams === 1 ? "" : "s"}, got ${actualParams}.`;
  return undefined;
}

function stripLeadingTrivia(text: string): string {
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index++;
      continue;
    }
    if (text.startsWith("//", index)) {
      const nextLine = text.indexOf("\n", index + 2);
      index = nextLine < 0 ? text.length : nextLine + 1;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return text.slice(index);
}

function findTopLevelArrow(source: string): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let quote: "\"" | "'" | "`" | undefined;
  let escaped = false;
  for (let index = 0; index < source.length - 1; index++) {
    const char = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") paren++;
    else if (char === ")") paren--;
    else if (char === "[") bracket++;
    else if (char === "]") bracket--;
    else if (char === "{") brace++;
    else if (char === "}") brace--;
    else if (char === "=" && source[index + 1] === ">" && paren === 0 && bracket === 0 && brace === 0) return index;
  }
  return -1;
}

function parameterCount(params: string): number {
  if (/^[A-Za-z_$][\w$]*$/.test(params)) return 1;
  if (!params.startsWith("(") || !params.endsWith(")")) return -1;
  const inner = params.slice(1, -1).trim();
  if (inner === "") return 0;
  const parts = splitTopLevel(inner);
  if (parts.some(part => part.trim() === "" || topLevelContains(part, "=") || part.trim().startsWith("..."))) return -1;
  return parts.length;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let quote: "\"" | "'" | "`" | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") paren++;
    else if (char === ")") paren--;
    else if (char === "[") bracket++;
    else if (char === "]") bracket--;
    else if (char === "{") brace++;
    else if (char === "}") brace--;
    else if (char === "," && paren === 0 && bracket === 0 && brace === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function topLevelContains(text: string, needle: string): boolean {
  return splitTopLevel(text).some(part => part.includes(needle));
}
