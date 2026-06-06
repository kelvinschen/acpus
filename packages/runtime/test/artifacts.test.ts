import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../src/artifacts.js";

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
});
