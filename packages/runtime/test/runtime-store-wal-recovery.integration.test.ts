import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readInspection, repairRuntimeStore } from "../src/index.js";
import { resolveRuntimeLayout, resolveRuntimeWorkspaceLayout } from "../src/runtime-layout.js";
import { openRuntimeStore } from "../src/store/store.js";
import { withStorageWorkspace } from "./support/storage-workspace.js";

describe("Runtime store WAL repair", () => {
  it.skipIf(process.platform === "win32")("preserves a v9 run update committed by a killed writer", async () => {
    await withStorageWorkspace("runtime-repair-crash-wal", async workspace => {
      const databasePath = await createLegacyStore(workspace);
      await commitRunUpdateThenKill(databasePath);
      expect((await lstat(`${databasePath}-wal`)).size).toBeGreaterThan(0);

      const repaired = await repairRuntimeStore(workspace);
      const archived = await readInspection(workspace, { kind: "run", runId: "run_crash_wal" });

      expect(repaired.isOk() && repaired.value).toEqual({ changed: true });
      expect(archived.isOk() && archived.value).toMatchObject({
        kind: "archived-run",
        run: {
          id: "run_crash_wal",
          name: "committed-in-wal",
          status: "completed",
          updatedAt: "2026-08-10T00:00:02.000Z",
        },
      });
    });
  });
});

async function createLegacyStore(workspace: string): Promise<string> {
  const store = await openRuntimeStore(workspace);
  store.close();
  const current = resolveRuntimeLayout(workspace);
  const database = new DatabaseSync(current.databasePath);
  try {
    database.prepare(`
      INSERT INTO runs (
        id, name, status, workflow_entry, source_graph_digest, created_at, updated_at
      ) VALUES ('run_crash_wal', 'before-crash', 'running', 'workflow.ts', 'sha256:test',
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:01.000Z')
    `).run();
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  const workspaceLayout = resolveRuntimeWorkspaceLayout(workspace);
  const manifest = JSON.parse(await readFile(current.manifestPath, "utf8")) as Record<string, unknown>;
  await rename(current.runtimeRoot, workspaceLayout.legacyRuntimeRoot);
  await rm(workspaceLayout.generationsRoot, { recursive: true, force: true });
  await writeFile(workspaceLayout.manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    workspaceKey: manifest.workspaceKey,
    canonicalPath: manifest.canonicalPath,
    platform: manifest.platform,
    createdAt: manifest.createdAt,
  }, null, 2)}\n`);
  return workspaceLayout.databasePath;
}

async function commitRunUpdateThenKill(databasePath: string): Promise<void> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.env.ACPUS_TEST_WAL_DATABASE);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    database.prepare("UPDATE runs SET name = ?, status = ?, updated_at = ? WHERE id = ?")
      .run("committed-in-wal", "completed", "2026-08-10T00:00:02.000Z", "run_crash_wal");
    process.stdout.write("committed\\n");
    setInterval(() => {}, 1000);
  `], {
    env: { ...process.env, ACPUS_TEST_WAL_DATABASE: databasePath },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", chunk => { output += String(chunk); });
  for (let attempt = 0; attempt < 100 && !output.includes("committed"); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(output).toContain("committed");
  child.kill("SIGKILL");
  await once(child, "exit");
}
