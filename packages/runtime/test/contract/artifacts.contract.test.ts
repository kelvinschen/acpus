import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactReferences, ArtifactStore } from "../../src/artifacts.js";
import { nodeKeyToStorageKey } from "../../src/keys.js";
import { isUnsafeRunId } from "../../src/run-id.js";

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
      expect(ref.uri).toBe("artifact://runs/run-001/nodes/workflow%2Fstep-a/output.txt");
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

    it("rejects unsafe run IDs before constructing artifact paths", () => {
      for (const runId of ["", "../escape", "a/b", "a\\b", "a:b", "a\0b"]) {
        expect(() => store.write(runId, "workflow/step-a", "output.txt", "x")).toThrow("Invalid runId");
        expect(() => store.create(runId, "workflow/step-a", "output.txt")).toThrow("Invalid runId");
        expect(() => store.append(runId, "workflow/step-a", "output.txt", "x")).toThrow("Invalid runId");
        expect(() => store.read(runId, "workflow/step-a", "output.txt")).toThrow("Invalid runId");
        expect(() => store.list(runId, "workflow/step-a")).toThrow("Invalid runId");
      }
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
        "artifact://runs/run-001/nodes/workflow%2Fstep-a/output.txt"
      );
      expect(ref.runId).toBe("run-001");
      expect(ref.nodeKey).toBe("workflow/step-a");
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
        uri: "artifact://runs/run-001/nodes/workflow%2Fstep-a/output.txt",
        runId: "run-001",
        nodeKey: "workflow/step-a",
        filename: "output.txt"
      });

      expect(ArtifactReferences.parse(ref.uri)).toEqual({
        uri: ref.uri,
        runId: "run-001",
        encodedNodeKey: "workflow%2Fstep-a",
        nodeKey: "workflow/step-a",
        filename: "output.txt"
      });
    });

    it("round-trips nodeKey through make → parse (H1 fix)", () => {
      const nodeKey = "workflow/mapped/item:file-a/lane:0";
      const ref = ArtifactReferences.make("run-001", nodeKey, "result.json");
      const parsed = ArtifactReferences.parse(ref.uri);
      // parse().nodeKey must equal the original resolved nodeKey
      expect(parsed.nodeKey).toBe(nodeKey);
      // encodedNodeKey preserves the URI-encoded form
      expect(parsed.encodedNodeKey).toBe("workflow%2Fmapped%2Fitem%3Afile-a%2Flane%3A0");
    });

    it("round-trips when static step IDs match dynamic dimension names", () => {
      const nodeKey = "workflow/item/child";
      const ref = ArtifactReferences.make("run-001", nodeKey, "output.txt");
      const parsed = ArtifactReferences.parse(ref.uri);
      expect(parsed.nodeKey).toBe(nodeKey);
      expect(parsed.encodedNodeKey).toBe("workflow%2Fitem%2Fchild");
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

    it("rejects unsafe run IDs when constructing artifact refs", () => {
      for (const runId of ["", "../escape", "a/b", "a\\b", "a:b", "a\0b"]) {
        expect(() => ArtifactReferences.make(runId, "workflow/step-a", "output.txt")).toThrow("Invalid runId");
      }
    });

    it("parses unsafe run IDs as URI syntax, but refuses to resolve them to paths", () => {
      const uri = "artifact://runs/../nodes/workflow%2Fstep-a/output.txt";
      expect(ArtifactReferences.parse(uri).runId).toBe("..");
      expect(ArtifactReferences.resolvePath(tmpDir, uri, isUnsafeRunId)).toBeUndefined();
    });

    it("rewrites only the run ID segment of matching artifact refs", () => {
      const source = "artifact://runs/source-run/nodes/workflow%2Fstep-a/output.txt";
      expect(ArtifactReferences.rewriteRunId(source, "source-run", "target-run")).toBe(
        "artifact://runs/target-run/nodes/workflow%2Fstep-a/output.txt"
      );
      expect(ArtifactReferences.rewriteRunId(source, "other-run", "target-run")).toBe(source);
      expect(ArtifactReferences.rewriteRunId("not-an-artifact", "source-run", "target-run")).toBe(
        "not-an-artifact"
      );
    });

    it("resolves artifact refs to safe host paths under the runs base directory", () => {
      const uri = "artifact://runs/run-001/nodes/workflow%2Fstep-a/output.txt";
      expect(ArtifactReferences.resolvePath(tmpDir, uri, () => false)).toBe(
        join(tmpDir, "run-001", "artifacts", nodeKeyToStorageKey("workflow/step-a"), "output.txt")
      );

      expect(ArtifactReferences.resolvePath(tmpDir, "not-an-artifact", () => false)).toBeUndefined();
      expect(ArtifactReferences.resolvePath(tmpDir, uri, (runId) => runId === "run-001")).toBeUndefined();
      expect(
        ArtifactReferences.resolvePath(
          tmpDir,
          "artifact://runs/run-001/nodes/workflow%2Fstep-a/../output.txt",
          () => false
        )
      ).toBeUndefined();
    });

    it("rejects artifact URIs with traversal patterns in encoded node key (M3)", () => {
      // Empty segments
      expect(
        ArtifactReferences.resolvePath(
          tmpDir,
          "artifact://runs/run-001/nodes//output.txt",
          () => false
        )
      ).toBeUndefined();

      // Dot segments in node key
      expect(
        ArtifactReferences.resolvePath(
          tmpDir,
          "artifact://runs/run-001/nodes/./workflow:step-a/output.txt",
          () => false
        )
      ).toBeUndefined();

      // Double-dot segments in node key
      expect(
        ArtifactReferences.resolvePath(
          tmpDir,
          "artifact://runs/run-001/nodes/../workflow:step-a/output.txt",
          () => false
        )
      ).toBeUndefined();

      const traversalLookingNodeKey = "workflow/../step-a";
      expect(
        ArtifactReferences.resolvePath(
          tmpDir,
          `artifact://runs/run-001/nodes/${encodeURIComponent(traversalLookingNodeKey)}/output.txt`,
          () => false
        )
      ).toBe(join(tmpDir, "run-001", "artifacts", nodeKeyToStorageKey(traversalLookingNodeKey), "output.txt"));
    });
  });
});
