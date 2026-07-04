import type { HookEvent, HookSource } from "./config.js";

export type HookJournalStatus = "completed" | "failed" | "timed_out";

export type HookJournalEntry = {
  id?: number;
  runId: string;
  eventSequence: number;
  triggerOrder: number;
  event: HookEvent;
  source: HookSource;
  sourcePath: string;
  handlerId: string;
  definitionHash: string;
  nodeKey?: string;
  status: HookJournalStatus;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  error?: string;
  triggeredAt: string;
};
