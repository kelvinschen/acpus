import { describe, expect, it, vi } from "vitest";
import {
  isSha256Digest,
  sha256Digest,
  sha256DigestHex,
  workflowSourceGraphDigest,
  type Sha256Digest,
} from "@acpus/core/content-identity";

describe("content identity", () => {
  it.each([
    ["an empty string", "", "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["ASCII text", "abc", "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["Unicode text", "你好", "sha256:670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e"],
    ["a retained UTF-8 BOM", "\uFEFFworkflow", "sha256:4fe75d117ecf04816fa1818564c2ad569616ff4b44a5c8cae6719e37f6db851f"],
  ])("hashes %s as its exact UTF-8 bytes", (_name, content, digest) => {
    expect(sha256Digest(content)).toBe(digest);
  });

  it("hashes Uint8Array input as raw bytes", () => {
    expect(sha256Digest(new Uint8Array([0, 255, 1])))
      .toBe("sha256:47ffa3ea45a70b8a41c2c0825df323c00a8b7a01c1ea06083cc41dddcc001123");
  });

  it.each([
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
    `sha256:${"A".repeat(64)}`,
    `sha-256:${"a".repeat(64)}`,
    `sha256:${"a".repeat(64)}\n`,
    null,
    42,
  ])("rejects a malformed digest: %j", value => {
    expect(isSha256Digest(value)).toBe(false);
  });

  it("recognizes the exact lowercase digest wire shape", () => {
    expect(isSha256Digest(`sha256:${"a".repeat(64)}`)).toBe(true);
  });

  it("extracts validated digest hex", () => {
    const digest = `sha256:${"a".repeat(64)}` as Sha256Digest;
    expect(sha256DigestHex(digest)).toBe("a".repeat(64));
    expect(() => sha256DigestHex("sha256:not-a-digest" as Sha256Digest)).toThrow(TypeError);
  });

  it("matches the source graph wire vector without mutating the inventory", () => {
    const files = [
      {
        path: "workflow.ts",
        digest: "sha256:a3f89ca6a4c23def1c495df33f1b77697b144fc6f13594439d0308a8653bbd62" as const,
      },
      {
        path: "helper.ts",
        digest: "sha256:5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29" as const,
      },
    ];
    const original = structuredClone(files);

    expect(workflowSourceGraphDigest("workflow.ts", files))
      .toBe("sha256:ce88d8244bbb18818ea5ef4c0f4fd5184d43e9e9c66e52cf28fb913b1b4edec1");
    expect(files).toEqual(original);
  });

  it("uses locale-independent code-unit ordering", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("localeCompare must not define content identity");
      });

    try {
      expect(workflowSourceGraphDigest("z.ts", [
        { path: "ä.ts", digest: `sha256:${"a".repeat(64)}` },
        { path: "z.ts", digest: `sha256:${"b".repeat(64)}` },
      ])).toBe("sha256:34b952ce107c5568dbc7a6a93ac6e9067debacf192833fd5b44da8ec12ed9a31");
    } finally {
      localeCompare.mockRestore();
    }
  });
});
