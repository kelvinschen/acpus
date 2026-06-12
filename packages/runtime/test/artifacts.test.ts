import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactReferences, ArtifactStore } from "../src/artifacts.js";

describe("ArtifactStore", () => {
  let tmpDir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-art-"));
    store = new ArtifactStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("write / read", () => {
    it("round-trips text content", () => {
      const ref = store.write("run-001", "workflow/step-a", "output.txt", "hello world");
      expect(ref.uri).toBe("artifact://runs/run-001/nodes/workflow:step-a/output.txt");
      expect(ref.runId).toBe("run-001");
      expect(ref.nodeKey).toBe("workflow/step-a");
      expect(ref.filename).toBe("output.txt");

      const content = store.read("run-001", "workflow/step-a", "output.txt");
      expect(content.toString()).toBe("hello world");
    });

    it("round-trips binary content", () => {
      const buffer = Buffer.from([1, 2, 3, 4, 5]);
      store.write("run-001", "workflow/step-a", "data.bin", buffer);
      const content = store.read("run-001", "workflow/step-a", "data.bin");
      expect(Buffer.from(content)).toEqual(buffer);
    });
  });

  describe("list", () => {
    it("lists all artifacts for a node", () => {
      store.write("run-001", "workflow/step-a", "stdout.txt", "output");
      store.write("run-001", "workflow/step-a", "transcript.json", "{}");

      const refs = store.list("run-001", "workflow/step-a");
      expect(refs).toHaveLength(2);
      expect(refs.map((r) => r.filename).sort()).toEqual(["stdout.txt", "transcript.json"]);
    });

    it("returns empty for node with no artifacts", () => {
      expect(store.list("run-001", "workflow/step-a")).toEqual([]);
    });
  });

  describe("parseArtifactRef", () => {
    it("parses a valid artifact URI", () => {
      const ref = store.parseArtifactRef(
        "artifact://runs/run-001/nodes/workflow:step-a/output.txt"
      );
      expect(ref.runId).toBe("run-001");
      expect(ref.nodeKey).toBe("workflow:step-a");
      expect(ref.filename).toBe("output.txt");
    });

    it("throws on invalid URI format", () => {
      expect(() => store.parseArtifactRef("not-a-uri")).toThrow("Invalid artifact URI");
    });
  });

  describe("ArtifactReferences", () => {
    it("constructs and parses artifact refs through the shared interface", () => {
      const ref = ArtifactReferences.make("run-001", "workflow/step-a", "output.txt");
      expect(ref).toEqual({
        uri: "artifact://runs/run-001/nodes/workflow:step-a/output.txt",
        runId: "run-001",
        nodeKey: "workflow/step-a",
        filename: "output.txt"
      });

      expect(ArtifactReferences.parse(ref.uri)).toEqual({
        uri: ref.uri,
        runId: "run-001",
        encodedNodeKey: "workflow:step-a",
        nodeKey: "workflow:step-a",
        filename: "output.txt"
      });
    });

    it("rejects artifact filenames with traversal or path separators", () => {
      expect(() => ArtifactReferences.make("run-001", "workflow/step-a", "../x.txt")).toThrow(
        "Invalid artifact filename"
      );
      expect(() => ArtifactReferences.make("run-001", "workflow/step-a", "nested/x.txt")).toThrow(
        "Invalid artifact filename"
      );
      expect(() => ArtifactReferences.make("run-001", "workflow/step-a", "nested\\x.txt")).toThrow(
        "Invalid artifact filename"
      );
    });

    it("rewrites only the run ID segment of matching artifact refs", () => {
      const source = "artifact://runs/source-run/nodes/workflow:step-a/output.txt";
      expect(ArtifactReferences.rewriteRunId(source, "source-run", "target-run")).toBe(
        "artifact://runs/target-run/nodes/workflow:step-a/output.txt"
      );
      expect(ArtifactReferences.rewriteRunId(source, "other-run", "target-run")).toBe(source);
      expect(ArtifactReferences.rewriteRunId("not-an-artifact", "source-run", "target-run")).toBe(
        "not-an-artifact"
      );
    });

    it("resolves artifact refs to safe host paths under the runs base directory", () => {
      const uri = "artifact://runs/run-001/nodes/workflow:step-a/output.txt";
      expect(ArtifactReferences.resolvePath(tmpDir, uri, () => false)).toBe(
        join(tmpDir, "run-001", "artifacts", "workflow:step-a", "output.txt")
      );

      expect(ArtifactReferences.resolvePath(tmpDir, "not-an-artifact", () => false)).toBeUndefined();
      expect(ArtifactReferences.resolvePath(tmpDir, uri, (runId) => runId === "run-001")).toBeUndefined();
      expect(
        ArtifactReferences.resolvePath(
          tmpDir,
          "artifact://runs/run-001/nodes/workflow:step-a/../output.txt",
          () => false
        )
      ).toBeUndefined();
    });
  });
});
