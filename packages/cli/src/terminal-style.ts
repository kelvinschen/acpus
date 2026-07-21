import type { Writable } from "node:stream";

export function supportsColor(stream: Writable): boolean {
  return (stream as Writable & { isTTY?: boolean }).isTTY === true
    && process.env.NO_COLOR === undefined;
}

export function ansi(text: string, code: number, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}
