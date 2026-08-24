import { createHash } from "node:crypto";
import { MessageId, type UserMessage } from "@deepseek-ai/dsh-llm";
import type { ResolvedTaskSelector } from "../task.js";

const NOTICE_FIELD_MAX_BYTES = 64 * 1024;
const NOTICE_SUMMARY_MAX_CHARACTERS = 120;

export type NoticeProjection = {
  runId: string;
  task: ResolvedTaskSelector;
  status: string;
  updatedAt: string;
  actionRequired?: {
    kind: "signal";
    signal: string;
    prompt?: string;
    expected?: string;
  };
  terminalSummary?: string;
};

type NoticeFact =
  | {
      kind: "awaiting-input";
      runId: string;
      task: ResolvedTaskSelector;
      updatedAt: string;
      signal: string;
      prompt?: string;
      expected?: string;
    }
  | {
      kind: "terminal";
      runId: string;
      task: ResolvedTaskSelector;
      updatedAt: string;
      status: "completed" | "failed" | "canceled";
    };

export type DerivedNotice = {
  id: string;
  fact: NoticeFact;
  message: UserMessage;
};

export type AcpusUserControlEvent =
  | {
      kind: "acpus-control-event";
      actor: "user";
      operation: "cancel";
      task: ResolvedTaskSelector;
      outcome: "applied";
      taskStatus: "canceled";
    }
  | {
      kind: "acpus-control-event";
      actor: "user";
      operation: "cancel";
      task: ResolvedTaskSelector;
      outcome: "rejected";
      taskStatus: string;
      reason: "already-terminal" | "not-controllable" | "temporarily-unavailable";
    };

export function userControlMessage(id: string, event: AcpusUserControlEvent): UserMessage {
  return {
    id: MessageId(id),
    role: "user",
    content: [{ type: "text", text: JSON.stringify(event) }],
    source: {
      kind: "plugin",
      plugin: "@acpus/dsh",
      form: "notice",
      summary: event.outcome === "applied"
        ? "The user canceled the delegated task"
        : "The user's delegated-task cancellation was rejected",
    },
  };
}

export function deriveNotice(projection: NoticeProjection): DerivedNotice | undefined {
  const terminalStatus = terminal(projection.status);
  const fact: NoticeFact | undefined = terminalStatus === undefined
    ? signalFact(projection)
    : {
        kind: "terminal",
        runId: projection.runId,
        task: projection.task,
        updatedAt: projection.updatedAt,
        status: terminalStatus,
      };
  if (fact === undefined) return undefined;

  const id = noticeId(fact);
  return {
    id,
    fact,
    message: noticeMessage(id, fact, projection.terminalSummary),
  };
}

function noticeId(fact: NoticeFact): string {
  const tuple = fact.kind === "awaiting-input"
    ? [
        fact.runId,
        fact.kind,
        fact.updatedAt,
        fact.signal,
        fact.prompt ?? null,
        fact.expected ?? null,
      ]
    : [
        fact.runId,
        fact.kind,
        fact.status,
        fact.updatedAt,
      ];
  return `acpus-notice:${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}

function signalFact(projection: NoticeProjection): NoticeFact | undefined {
  const requirement = projection.actionRequired;
  if (requirement?.kind !== "signal") return undefined;
  return {
    kind: "awaiting-input",
    runId: projection.runId,
    task: projection.task,
    updatedAt: projection.updatedAt,
    signal: requirement.signal,
    ...(requirement.prompt === undefined ? {} : { prompt: requirement.prompt }),
    ...(requirement.expected === undefined ? {} : { expected: requirement.expected }),
  };
}

function terminal(status: string): Extract<NoticeFact, { kind: "terminal" }>["status"] | undefined {
  return status === "completed" || status === "failed" || status === "canceled"
    ? status
    : undefined;
}

function noticeMessage(id: string, fact: NoticeFact, terminalSummary?: string): UserMessage {
  const payload = fact.kind === "awaiting-input"
      ? {
        kind: fact.kind,
        task: fact.task,
        signal: fact.signal,
        ...(fact.prompt === undefined ? {} : { prompt: boundedText(fact.prompt) }),
        ...(fact.expected === undefined ? {} : { expected: boundedText(fact.expected) }),
      }
      : {
        kind: fact.kind,
        task: fact.task,
        status: fact.status,
        ...(terminalSummary === undefined ? {} : { summary: boundedText(terminalSummary) }),
      };
  const summary = fact.kind === "awaiting-input"
    ? "The delegated task requires user input"
    : `The delegated task ${fact.status}`;
  return {
    id: MessageId(id),
    role: "user",
    content: [{ type: "text", text: JSON.stringify(payload) }],
    source: {
      kind: "plugin",
      plugin: "@acpus/dsh",
      form: "notice",
      summary: summary.slice(0, NOTICE_SUMMARY_MAX_CHARACTERS),
    },
  };
}

function boundedText(value: string): string | { text: string; truncated: true } {
  if (Buffer.byteLength(value, "utf8") <= NOTICE_FIELD_MAX_BYTES) return value;
  const bytes = Buffer.from(value);
  return {
    text: bytes.subarray(0, NOTICE_FIELD_MAX_BYTES).toString("utf8").replace(/\uFFFD$/u, ""),
    truncated: true,
  };
}
