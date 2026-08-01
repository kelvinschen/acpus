import { describe, expect, it } from "vitest";
import { rewriteArtifactValue } from "../src/artifacts/rewrite.js";

describe("artifact reference rewriting", () => {
  it("rewrites nested source artifact URIs for fork replay facts", () => {
    expect(rewriteArtifactValue({
      nodeKey: "first",
      output: {
        primary: { kind: "artifact", uri: "artifact://source/artifact_a", mediaType: "text/plain" },
        nested: [{ kind: "artifact", uri: "artifact://source/artifact_b" }],
        external: { kind: "artifact", uri: "artifact://other/artifact_c" },
      },
    }, "source", "fork", {
      artifact_a: "artifact_fork_a",
      artifact_b: "artifact_fork_b",
    })._unsafeUnwrap()).toEqual({
      nodeKey: "first",
      output: {
        primary: { kind: "artifact", uri: "artifact://fork/artifact_fork_a", mediaType: "text/plain" },
        nested: [{ kind: "artifact", uri: "artifact://fork/artifact_fork_b" }],
        external: { kind: "artifact", uri: "artifact://other/artifact_c" },
      },
    });
  });

  it("fails when a source artifact id has no fork id", () => {
    expect(rewriteArtifactValue(
      { kind: "artifact", uri: "artifact://source/missing" },
      "source",
      "fork",
      {},
    )._unsafeUnwrapErr()).toEqual({
      type: "artifact-rewrite-failure",
      artifactId: "missing",
      message: "Missing fork artifact id for 'missing'.",
    });
  });

  it("preserves and rewrites own __proto__ data without prototype mutation", () => {
    const input = JSON.parse('{"__proto__":{"kind":"artifact","uri":"artifact://source/artifact_a"}}');
    const rewritten = rewriteArtifactValue(input, "source", "fork", {
      artifact_a: "artifact_fork_a",
    })._unsafeUnwrap() as Record<string, unknown>;

    expect(Object.getPrototypeOf(rewritten)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(rewritten, "__proto__")).toBe(true);
    expect(JSON.stringify(rewritten)).toBe('{"__proto__":{"kind":"artifact","uri":"artifact://fork/artifact_fork_a"}}');
  });
});
