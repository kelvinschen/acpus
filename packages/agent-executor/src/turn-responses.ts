import type { AcpEvent, AcpJsonValue } from "@acpus/acp";

export function createTurnResponseCollector() {
  const responses: string[] = [];
  let openResponse: number | undefined;
  let finalCandidate: number | undefined;

  return {
    observe(event: AcpEvent): void {
      if (event.type === "message") {
        if (event.channel === "thought") {
          openResponse = undefined;
          return;
        }
        const text = textBlockContent(event.content);
        if (text === undefined || text.length === 0) return;
        if (openResponse === undefined) {
          openResponse = responses.push(text) - 1;
        } else {
          responses[openResponse] += text;
        }
        finalCandidate = openResponse;
        return;
      }
      if (event.type === "tool") {
        openResponse = undefined;
        if (event.action === "call") finalCandidate = undefined;
        return;
      }
      if (event.type === "plan") {
        openResponse = undefined;
      }
    },
    snapshot(): readonly string[] {
      return [...responses];
    },
    complete(): { responses: readonly string[]; finalResponse: string } {
      const snapshot = [...responses];
      return {
        responses: snapshot,
        finalResponse: finalCandidate === undefined ? "" : snapshot[finalCandidate]!,
      };
    },
  };
}

function textBlockContent(content: AcpJsonValue): string | undefined {
  if (content === null || Array.isArray(content) || typeof content !== "object") return undefined;
  return content.type === "text" && typeof content.text === "string" ? content.text : undefined;
}
