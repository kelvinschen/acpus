import { describe, it, expect } from "vitest";
import {
  resolveNodeKey,
  parseNodeKey,
  staticNodePathFromKey,
  isNodeKeyAtOrBelow,
  isNodeKeyInDynamicScope,
  withNodeKeyPrefix,
  encodeNodeKeyForFs,
  encodeNodeKeyForDir
} from "../src/keys.js";
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

describe("parseNodeKey", () => {
  it("returns static path and dynamic dimensions for a composite key", () => {
    expect(parseNodeKey("workflow/mapped/process/item:file-a/lane:0/branch:1/round:2")).toEqual({
      nodeKey: "workflow/mapped/process/item:file-a/lane:0/branch:1/round:2",
      staticPath: "workflow/mapped/process",
      staticSegments: ["workflow", "mapped", "process"],
      dynamic: {
        fanoutItemId: "file-a",
        laneId: "0",
        parallelBranchId: "1",
        loopRound: 2
      }
    });
  });

  it("preserves a plain key as static path with no dynamic dimensions", () => {
    expect(parseNodeKey("workflow/build")).toEqual({
      nodeKey: "workflow/build",
      staticPath: "workflow/build",
      staticSegments: ["workflow", "build"],
      dynamic: {}
    });
  });
});

describe("staticNodePathFromKey", () => {
  it("derives the static IR path from a resolved key", () => {
    expect(staticNodePathFromKey("workflow/aggregate/tally/round:1")).toBe(
      "workflow/aggregate/tally"
    );
  });
});

describe("isNodeKeyAtOrBelow", () => {
  it("matches the same static path", () => {
    expect(isNodeKeyAtOrBelow("workflow/build", "workflow/build")).toBe(true);
  });

  it("matches a descendant static path while ignoring dynamic dimensions", () => {
    expect(
      isNodeKeyAtOrBelow("workflow/aggregate/tally/round:1", "workflow/aggregate")
    ).toBe(true);
  });

  it("does not match sibling static paths", () => {
    expect(isNodeKeyAtOrBelow("workflow/publish", "workflow/build")).toBe(false);
  });
});

describe("isNodeKeyInDynamicScope", () => {
  it("matches every node key for an empty dynamic scope", () => {
    expect(isNodeKeyInDynamicScope("workflow/build", {})).toBe(true);
    expect(isNodeKeyInDynamicScope("workflow/mapped/item:file-a/lane:0", {})).toBe(true);
  });

  it("matches fanout item ids using Node Key value sanitization", () => {
    expect(
      isNodeKeyInDynamicScope("workflow/mapped/item:path_to_file", {
        fanoutItemId: "path/to/file"
      })
    ).toBe(true);
  });

  it("matches repeated fanout and lane dimensions by dynamic frame", () => {
    const nodeKey = "workflow/outer/item:outer/lane:0/workflow/child/item:inner/lane:0";

    expect(isNodeKeyInDynamicScope(nodeKey, { fanoutItemId: "outer", laneId: "0" })).toBe(true);
    expect(isNodeKeyInDynamicScope(nodeKey, { fanoutItemId: "inner", laneId: "0" })).toBe(true);
    expect(isNodeKeyInDynamicScope(nodeKey, { fanoutItemId: "outer", laneId: "1" })).toBe(false);
    expect(isNodeKeyInDynamicScope(nodeKey, { fanoutItemId: "inner", laneId: "1" })).toBe(false);
  });

  it("distinguishes lane ids", () => {
    expect(isNodeKeyInDynamicScope("workflow/mapped/item:file-a/lane:0", { laneId: "0" })).toBe(
      true
    );
    expect(isNodeKeyInDynamicScope("workflow/mapped/item:file-a/lane:1", { laneId: "0" })).toBe(
      false
    );
  });

  it("distinguishes parallel branch ids", () => {
    expect(isNodeKeyInDynamicScope("workflow/group/branch:0", { parallelBranchId: "0" })).toBe(
      true
    );
    expect(isNodeKeyInDynamicScope("workflow/group/branch:1", { parallelBranchId: "0" })).toBe(
      false
    );
  });

  it("matches nested parallel branch descendants within the parent branch scope", () => {
    expect(isNodeKeyInDynamicScope("workflow/outer/inner/branch:0.1", { parallelBranchId: "0" })).toBe(
      true
    );
    expect(isNodeKeyInDynamicScope("workflow/outer/inner/branch:0.1", { parallelBranchId: "0.1" })).toBe(
      true
    );
    expect(isNodeKeyInDynamicScope("workflow/outer/other/branch:1.0", { parallelBranchId: "0" })).toBe(
      false
    );
  });

  it("distinguishes loop rounds", () => {
    expect(isNodeKeyInDynamicScope("workflow/loop/round:1", { loopRound: 1 })).toBe(true);
    expect(isNodeKeyInDynamicScope("workflow/loop/round:2", { loopRound: 1 })).toBe(false);
  });

  it("requires every provided dynamic scope dimension to match", () => {
    const nodeKey = "workflow/nested/item:file-a/lane:0/branch:1/round:2";

    expect(
      isNodeKeyInDynamicScope(nodeKey, {
        fanoutItemId: "file-a",
        laneId: "0",
        parallelBranchId: "1",
        loopRound: 2
      })
    ).toBe(true);
    expect(
      isNodeKeyInDynamicScope(nodeKey, {
        fanoutItemId: "file-a",
        laneId: "0",
        parallelBranchId: "0",
        loopRound: 2
      })
    ).toBe(false);
  });

  it("does not match when the node key is missing a required dynamic dimension", () => {
    expect(isNodeKeyInDynamicScope("workflow/build", { fanoutItemId: "file-a" })).toBe(false);
    expect(isNodeKeyInDynamicScope("workflow/mapped/item:file-a", { laneId: "0" })).toBe(false);
  });
});

describe("withNodeKeyPrefix", () => {
  it("returns the child key unchanged without a prefix", () => {
    expect(withNodeKeyPrefix(undefined, "workflow/child")).toBe("workflow/child");
  });

  it("nests a child key under a parent prefix", () => {
    expect(withNodeKeyPrefix("workflow/sub", "workflow/child")).toBe(
      "workflow/sub/workflow/child"
    );
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
