import type { AcpRuntimeEvent } from "acpx/runtime";

export function createTurnResponseCollector() {
  const responses: string[] = [];
  let openResponse: number | undefined;
  let finalCandidate: number | undefined;

  return {
    observe(event: AcpRuntimeEvent): void {
      if (event.type === "text_delta") {
        if (event.stream === "thought") {
          openResponse = undefined;
          return;
        }
        if (event.text.length === 0) return;
        if (openResponse === undefined) {
          openResponse = responses.push(event.text) - 1;
        } else {
          responses[openResponse] += event.text;
        }
        finalCandidate = openResponse;
        return;
      }
      if (event.type === "tool_call") {
        openResponse = undefined;
        if (event.tag !== "tool_call_update") finalCandidate = undefined;
        return;
      }
      if (event.type === "status" && event.tag === "plan") {
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
