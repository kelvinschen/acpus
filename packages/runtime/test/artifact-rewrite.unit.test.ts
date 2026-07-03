import { describe, expect, it } from "vitest";
import { rewriteArtifactValue } from "../src/artifacts/rewrite.js";

describe("artifact reference rewriting", () => {
  it("rewrites nested source artifact URIs for fork seed payloads", () => {
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
    })).toEqual({
      nodeKey: "first",
      output: {
        primary: { kind: "artifact", uri: "artifact://fork/artifact_fork_a", mediaType: "text/plain" },
        nested: [{ kind: "artifact", uri: "artifact://fork/artifact_fork_b" }],
        external: { kind: "artifact", uri: "artifact://other/artifact_c" },
      },
    });
  });

  it("fails when a source artifact id has no fork id", () => {
    expect(() => rewriteArtifactValue(
      { kind: "artifact", uri: "artifact://source/missing" },
      "source",
      "fork",
      {},
    )).toThrow("Missing fork artifact id for 'missing'.");
  });
});
