import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRESET_ID = "acpus";
const OWNER = "@acpus/dsh";
const MANAGED_FILES = ["agent.cordis.yml", "preset.yml"] as const;

type PresetMarker = {
  owner: typeof OWNER;
  presetId: typeof PRESET_ID;
  files: readonly string[];
};

export class AcpusPresetCollisionError extends Error {
  readonly code = "ACPUS_PRESET_COLLISION";

  constructor(readonly presetPath: string) {
    super(
      `Cannot install Acpus mode because '${presetPath}' already exists without an @acpus/dsh ownership marker.`,
    );
    this.name = "AcpusPresetCollisionError";
  }
}

export type AcpusPresetInstallOptions = {
  dshHome?: string;
  sourceDir?: string;
};

export type AcpusPresetInstallation = {
  presetPath: string;
  markerPath: string;
};

export async function installAcpusPreset(
  options: AcpusPresetInstallOptions = {},
): Promise<AcpusPresetInstallation> {
  const paths = presetPaths(options);
  await mkdir(paths.root, { recursive: true });
  const [presetExists, marker] = await Promise.all([
    exists(paths.preset),
    readMarker(paths.marker),
  ]);
  if (presetExists && marker === undefined) {
    throw new AcpusPresetCollisionError(paths.preset);
  }
  if (!presetExists && marker !== undefined) {
    await unlink(paths.marker);
  }

  const staging = join(paths.root, `.acpus-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const file of MANAGED_FILES) {
      await writeExclusive(join(staging, file), await readFile(join(paths.source, file)));
    }
    await writeExclusive(join(staging, "marker.json"), markerBytes());
    if (!presetExists) {
      await rename(staging, paths.preset);
      await rename(join(paths.preset, "marker.json"), paths.marker);
    } else {
      for (const file of MANAGED_FILES) {
        await replaceFile(join(staging, file), join(paths.preset, file));
      }
      await replaceFile(join(staging, "marker.json"), paths.marker);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { presetPath: paths.preset, markerPath: paths.marker };
}

export async function uninstallAcpusPreset(
  options: AcpusPresetInstallOptions = {},
): Promise<boolean> {
  const paths = presetPaths(options);
  if (await readMarker(paths.marker) === undefined) return false;
  for (const file of MANAGED_FILES) {
    await rm(join(paths.preset, file), { force: true });
  }
  await rm(paths.marker, { force: true });
  try {
    await rmdir(paths.preset);
  } catch (error) {
    if (!isCode(error, "ENOTEMPTY") && !isCode(error, "ENOENT")) throw error;
  }
  return true;
}

function presetPaths(options: AcpusPresetInstallOptions) {
  const dshHome = options.dshHome
    ?? process.env.DSH_HOME
    ?? join(homedir(), ".dsh");
  const root = join(dshHome, ".agent-presets");
  const preset = join(root, PRESET_ID);
  return {
    root,
    preset,
    marker: `${preset}.${OWNER.replaceAll("/", "-").replaceAll("@", "")}.json`,
    source: options.sourceDir
      ?? fileURLToPath(new URL("../../preset/acpus/", import.meta.url)),
  };
}

async function readMarker(path: string): Promise<PresetMarker | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!value || typeof value !== "object") return undefined;
  const marker = value as Record<string, unknown>;
  const files = marker.files;
  return marker.owner === OWNER
    && marker.presetId === PRESET_ID
    && Array.isArray(files)
    && files.length === MANAGED_FILES.length
    && MANAGED_FILES.every(file => files.includes(file))
    ? marker as PresetMarker
    : undefined;
}

function markerBytes(): Buffer {
  const marker: PresetMarker = {
    owner: OWNER,
    presetId: PRESET_ID,
    files: MANAGED_FILES,
  };
  return Buffer.from(`${JSON.stringify(marker)}\n`);
}

async function replaceFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
}

async function writeExclusive(path: string, content: Uint8Array): Promise<void> {
  const file = await open(path, "wx");
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === code;
}
