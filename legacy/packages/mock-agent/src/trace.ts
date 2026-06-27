import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export interface TraceEvent {
  event: string;
  sessionId?: string;
  promptText?: string;
  ruleName?: string;
  chunkIndex?: number;
  text?: string;
  stopReason?: string;
  error?: unknown;
  [key: string]: unknown;
}

export type TraceMode = "append" | "overwrite";

export class TraceWriter {
  constructor(readonly path: string, options: { mode?: TraceMode } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    if ((options.mode ?? "append") === "overwrite") {
      rmSync(path, { force: true });
    }
  }

  write(event: TraceEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}
