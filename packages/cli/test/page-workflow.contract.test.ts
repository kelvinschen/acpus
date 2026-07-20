import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./support/cli-runner.js";

describe("landing-page workflow source", () => {
  it("matches the highlighted page source line for line", async () => {
    const [workflow, pageScript] = await Promise.all([
      readFile(join(repoRoot, "page/workflow.ts"), "utf8"),
      readFile(join(repoRoot, "page/page.js"), "utf8"),
    ]);
    const assignment = "const CODE_LINES = ";
    const start = pageScript.indexOf(assignment);
    const end = pageScript.indexOf("\n];", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const literal = pageScript.slice(start + assignment.length, end + 2);
    const codeLines = Function(`"use strict"; return (${literal});`)() as Array<{ html: string }>;
    const displayedSource = codeLines
      .map(({ html }) => decodeEntities(html.replace(/<[^>]+>/g, "")))
      .join("\n");

    expect(`${displayedSource}\n`).toBe(workflow);
  });
});

function decodeEntities(value: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&gt;": ">",
    "&lt;": "<",
    "&quot;": '"',
    "&#39;": "'",
  };
  return value.replace(/&(amp|gt|lt|quot|#39);/g, entity => entities[entity] ?? entity);
}
