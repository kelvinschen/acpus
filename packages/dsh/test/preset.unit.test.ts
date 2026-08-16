import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpusPresetCollisionError,
  installAcpusPreset,
  uninstallAcpusPreset,
} from "@acpus/dsh/preset";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })));
});

describe("Acpus DSH preset installation", () => {
  it("installs, refreshes, and explicitly removes only its marker-owned files", async () => {
    const dshHome = await temporaryDirectory("acpus-dsh-preset-owned-");
    const installed = await installAcpusPreset({ dshHome });

    expect(await readFile(join(installed.presetPath, "preset.yml"), "utf8"))
      .toContain("order: 5");
    expect(JSON.parse(await readFile(installed.markerPath, "utf8"))).toEqual({
      owner: "@acpus/dsh",
      presetId: "acpus",
      files: ["agent.cordis.yml", "preset.yml"],
    });

    const unmanaged = join(installed.presetPath, "notes.txt");
    await Promise.all([
      writeFile(join(installed.presetPath, "preset.yml"), "stale\n"),
      writeFile(unmanaged, "keep\n"),
    ]);
    await installAcpusPreset({ dshHome });

    expect(await readFile(join(installed.presetPath, "preset.yml"), "utf8"))
      .toContain("name: Acpus 模式");
    expect(await uninstallAcpusPreset({ dshHome })).toBe(true);
    expect(await readFile(unmanaged, "utf8")).toBe("keep\n");
    expect(await uninstallAcpusPreset({ dshHome })).toBe(false);
  });

  it("rejects an unowned preset without changing it", async () => {
    const dshHome = await temporaryDirectory("acpus-dsh-preset-collision-");
    const presetPath = join(dshHome, ".agent-presets", "acpus");
    const file = join(presetPath, "preset.yml");
    await mkdir(presetPath, { recursive: true });
    await writeFile(file, "name: Mine\n");

    await expect(installAcpusPreset({ dshHome }))
      .rejects.toBeInstanceOf(AcpusPresetCollisionError);
    expect(await readFile(file, "utf8")).toBe("name: Mine\n");
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
