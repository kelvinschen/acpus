import { describe, it, expect } from "vitest";
import { resolveNodeKey, encodeNodeKeyForFs, encodeNodeKeyForDir } from "../src/keys.js";
import type { NodeKeyTemplate } from "@acpus/core";

function baseTemplate(overrides?: Partial<NodeKeyTemplate>): NodeKeyTemplate {
  return {
    astVersion: 1,
    nodePath: "workflow/step-a",
    ...overrides
  };
}

describe("resolveNodeKey", () => {
  it("resolves a plain key with no dynamic dimensions", () => {
    const template = baseTemplate();
    expect(resolveNodeKey(template)).toBe("workflow/step-a");
  });

  it("resolves a fanout item id", () => {
    const template = baseTemplate({
      nodePath: "workflow/mapped",
      fanoutItemId: true
    });
    expect(resolveNodeKey(template, { fanoutItemId: "file-a" })).toBe(
      "workflow/mapped/item:file-a"
    );
  });

  it("resolves fanout item with lane id", () => {
    const template = baseTemplate({
      nodePath: "workflow/mapped",
      fanoutItemId: true,
      laneId: true
    });
    expect(
      resolveNodeKey(template, { fanoutItemId: "file-a", laneId: "0" })
    ).toBe("workflow/mapped/item:file-a/lane:0");
  });

  it("resolves a loop round", () => {
    const template = baseTemplate({
      nodePath: "workflow/iterator",
      loopRound: true
    });
    expect(resolveNodeKey(template, { loopRound: 3 })).toBe(
      "workflow/iterator/round:3"
    );
  });

  it("resolves a parallel branch id", () => {
    const template = baseTemplate({
      nodePath: "workflow/parallel-group",
      parallelBranchId: true
    });
    expect(resolveNodeKey(template, { parallelBranchId: "0" })).toBe(
      "workflow/parallel-group/branch:0"
    );
  });

  it("resolves a nested composite key", () => {
    const template = baseTemplate({
      nodePath: "workflow/mapped",
      fanoutItemId: true,
      laneId: true,
      loopRound: true
    });
    expect(
      resolveNodeKey(template, {
        fanoutItemId: "file-a",
        laneId: "0",
        loopRound: 2
      })
    ).toBe("workflow/mapped/item:file-a/lane:0/round:2");
  });

  it("is stable (same input → same output)", () => {
    const template = baseTemplate({
      nodePath: "workflow/mapped",
      fanoutItemId: true,
      laneId: true
    });
    const dynamic = { fanoutItemId: "file-a", laneId: "0" };
    const first = resolveNodeKey(template, dynamic);
    const second = resolveNodeKey(template, dynamic);
    expect(first).toBe(second);
  });

  it("sanitizes filesystem-unsafe characters in values", () => {
    const template = baseTemplate({
      nodePath: "workflow/mapped",
      fanoutItemId: true
    });
    expect(resolveNodeKey(template, { fanoutItemId: "path/to/file" })).toBe(
      "workflow/mapped/item:path_to_file"
    );
  });

  it("omits dynamic dimensions when value is undefined", () => {
    const result = resolveNodeKey(
      { astVersion: 1, nodePath: "workflow/mapped" },
      { fanoutItemId: "x" }
    );
    expect(result).toBe("workflow/mapped/item:x");
  });
});

describe("encodeNodeKeyForFs", () => {
  it("encodes a plain key with .json suffix", () => {
    expect(encodeNodeKeyForFs("workflow/step-a")).toBe("workflow:step-a.json");
  });

  it("encodes a deeply nested key", () => {
    expect(encodeNodeKeyForFs("workflow/mapped/item:file-a/lane:0")).toBe(
      "workflow:mapped:item:file-a:lane:0.json"
    );
  });

  it("returns .json for a key with no slashes", () => {
    expect(encodeNodeKeyForFs("root")).toBe("root.json");
  });
});

describe("encodeNodeKeyForDir", () => {
  it("encodes a plain key without suffix", () => {
    expect(encodeNodeKeyForDir("workflow/step-a")).toBe("workflow:step-a");
  });

  it("encodes a deeply nested key", () => {
    expect(encodeNodeKeyForDir("workflow/mapped/item:file-a/lane:0")).toBe(
      "workflow:mapped:item:file-a:lane:0"
    );
  });

  it("returns key unchanged when no slashes", () => {
    expect(encodeNodeKeyForDir("root")).toBe("root");
  });

  it("is consistent with encodeNodeKeyForFs (minus suffix)", () => {
    const key = "workflow/mapped/item:x/lane:0";
    expect(encodeNodeKeyForFs(key)).toBe(encodeNodeKeyForDir(key) + ".json");
  });
});
