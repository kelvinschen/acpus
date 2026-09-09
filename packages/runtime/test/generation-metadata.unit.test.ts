import { lstat, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  readGenerationMetadataForRecovery,
  readRunIndex,
  RuntimeMetadataFormatError,
  type RuntimeGenerationMetadata,
} from "../src/storage/generation-metadata.js";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  lstat: vi.fn(async () => ({ isSymbolicLink: () => false, isFile: () => true })),
  readFile: vi.fn(),
}));

const path = "/private/runtime/metadata.json";

describe("Runtime metadata reads", () => {
  it.each(["EACCES", "EIO"])("preserves %s read failures instead of treating data as corrupt", async code => {
    const failure = Object.assign(new Error("Metadata read failed"), { code, path });
    vi.mocked(readFile).mockRejectedValue(failure);

    await expect(readGenerationMetadataForRecovery(path)).rejects.toBe(failure);
    await expect(readRunIndex(path)).rejects.toBe(failure);
  });

  it("reads valid generation metadata and archived run indexes", async () => {
    const metadata: RuntimeGenerationMetadata = {
      schemaVersion: 1,
      id: "gen_00000000-0000-4000-8000-000000000000",
      storageVersion: 9,
      createdAt: "2026-08-10T00:00:00.000Z",
    };
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(metadata));
    await expect(readGenerationMetadataForRecovery(path)).resolves.toEqual(metadata);

    const index = { schemaVersion: 1, runs: [] };
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(index));
    await expect(readRunIndex(path)).resolves.toEqual(index);
  });

  it("keeps absent metadata distinct from read failures", async () => {
    const missing = Object.assign(new Error("Missing metadata"), { code: "ENOENT" });
    vi.mocked(lstat).mockRejectedValueOnce(missing).mockRejectedValueOnce(missing);

    await expect(readGenerationMetadataForRecovery(path)).resolves.toBeUndefined();
    await expect(readRunIndex(path)).resolves.toBeUndefined();
  });

  it("retains recovery handling for malformed JSON", async () => {
    vi.mocked(readFile).mockResolvedValue("{invalid json");

    await expect(readGenerationMetadataForRecovery(path)).resolves.toBeUndefined();
    await expect(readRunIndex(path)).rejects.toBeInstanceOf(RuntimeMetadataFormatError);
  });
});
