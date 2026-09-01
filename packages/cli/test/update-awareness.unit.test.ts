import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import {
  createUpdateAwareness,
  formatUpdateNotice,
  isAvailableUpdate,
  isUpdateAwarenessEligible,
  isUpdateCheckDue,
  runUpdateAwarenessWorker,
} from "../src/update/awareness.js";
import { CaptureStream } from "./support/capture-stream.js";

class TtyCaptureStream extends CaptureStream {
  isTTY = true;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("update awareness", () => {
  it("runs only for interactive command actions outside automated environments", () => {
    const stdout = new TtyCaptureStream();
    const stderr = new TtyCaptureStream();
    const input = {
      argv: ["workflow", "catalog"],
      topLevelCommand: "workflow",
      stdout,
      stderr,
      env: {} as NodeJS.ProcessEnv,
    };

    expect(isUpdateAwarenessEligible(input)).toBe(true);
    expect(isUpdateAwarenessEligible({ ...input, argv: ["workflow", "catalog", "--help"] })).toBe(false);
    expect(isUpdateAwarenessEligible({ ...input, topLevelCommand: "doctor", argv: ["doctor"] })).toBe(true);
    expect(isUpdateAwarenessEligible({ ...input, env: { CI: "1" } })).toBe(false);
    expect(isUpdateAwarenessEligible({ ...input, env: { NO_UPDATE_NOTIFIER: "1" } })).toBe(false);
    expect(isUpdateAwarenessEligible({ ...input, stdout: new CaptureStream() })).toBe(false);
  });

  it("accepts only newer stable releases supported by the running Node version", () => {
    const update = { checkedAt: "2026-07-23T00:00:00.000Z", version: "0.8.0", engines: { node: ">=22.18.0" } };

    expect(isAvailableUpdate(update, "0.7.2", "22.18.0")).toBe(true);
    expect(isAvailableUpdate({ ...update, version: "0.8.0-beta.1" }, "0.7.2", "22.18.0")).toBe(false);
    expect(isAvailableUpdate({ ...update, engines: { node: ">=25" } }, "0.7.2", "22.18.0")).toBe(false);
    expect(isAvailableUpdate(update, "0.8.0", "22.18.0")).toBe(false);
  });

  it("waits four hours before another remote attempt", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");

    expect(isUpdateCheckDue(undefined, now)).toBe(true);
    expect(isUpdateCheckDue("2026-07-23T08:00:00.001Z", now)).toBe(false);
    expect(isUpdateCheckDue("2026-07-23T08:00:00.000Z", now)).toBe(true);
  });

  it("does not refresh the stable router Skill after a CLI update", () => {
    expect(formatUpdateNotice({
      currentVersion: "0.7.2",
      update: { checkedAt: "2026-07-23T00:00:00.000Z", version: "0.8.0" },
      color: false,
    })).toBe([
      "Update available: acpus 0.7.2 → 0.8.0",
      "Run: npm install -g acpus@latest",
      "",
    ].join("\n"));
  });

  it("emphasizes update actions in a color terminal", () => {
    expect(formatUpdateNotice({
      currentVersion: "0.7.2",
      update: { checkedAt: "2026-07-23T00:00:00.000Z", version: "0.8.0" },
      color: true,
    })).toBe([
      "\u001b[1;33mUpdate available:\u001b[0m acpus 0.7.2 → 0.8.0",
      "\u001b[1;33mRun:\u001b[0m \u001b[1;36mnpm install -g acpus@latest\u001b[0m",
      "",
    ].join("\n"));
  });

  it("does not append a Doctor notice after a failed Doctor run", async () => {
    const home = await mkdtemp(join(tmpdir(), "acpus-update-awareness-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const cache = join(home, ".acpus", "cache", "update-awareness");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "last-attempt.json"), JSON.stringify({ checkedAt: new Date().toISOString() }));
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    try {
      const stdout = new TtyCaptureStream();
      const stderr = new TtyCaptureStream();
      const program = new Command("acpus");
      const doctor = new Command("doctor");
      program.addCommand(doctor);
      const awareness = createUpdateAwareness({
        argv: ["doctor"],
        stdout,
        stderr,
        env: {} as NodeJS.ProcessEnv,
      });

      awareness.start(doctor);
      await awareness.finish(1);

      expect(stdout.text).toBe("");
      expect(stderr.text).toBe("");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("limits update notices per installed version while retaining the budget across releases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
    const home = await mkdtemp(join(tmpdir(), "acpus-update-awareness-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const cache = join(home, ".acpus", "cache", "update-awareness");
    const notices = join(cache, "notices.json");
    const program = new Command("acpus");
    const doctor = new Command("doctor");
    program.addCommand(doctor);
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    try {
      await mkdir(cache, { recursive: true });
      const show = async (version: string): Promise<string> => {
        await writeFile(join(cache, "last-attempt.json"), JSON.stringify({ checkedAt: new Date().toISOString() }));
        await writeFile(join(cache, "available.json"), JSON.stringify({ checkedAt: new Date().toISOString(), version }));
        const stdout = new TtyCaptureStream();
        const stderr = new TtyCaptureStream();
        const awareness = createUpdateAwareness({
          argv: ["doctor"],
          stdout,
          stderr,
          env: {} as NodeJS.ProcessEnv,
        });
        awareness.start(doctor);
        await awareness.finish(0);
        return stripVTControlCharacters(stderr.text);
      };

      const firstNotice = await show("99.0.0");
      expect(firstNotice).toContain("→ 99.0.0");
      expect(firstNotice).not.toContain("Refresh skill:");
      expect(await show("99.0.0")).toBe("");
      for (const version of ["100.0.0", "101.0.0", "102.0.0"]) {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
        expect(await show(version)).toContain(`→ ${version}`);
      }
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
      expect(await show("103.0.0")).toBe("");
      expect(JSON.parse(await readFile(notices, "utf8"))).toMatchObject({ update: { count: 4 } });

      await writeFile(notices, JSON.stringify({
        update: { installedVersion: "0.0.0", count: 4, notifiedAt: new Date().toISOString() },
        skills: {},
      }));
      expect(await show("104.0.0")).toContain("→ 104.0.0");
      expect(JSON.parse(await readFile(notices, "utf8"))).toMatchObject({ update: { count: 1 } });
      expect(JSON.parse(await readFile(notices, "utf8"))).not.toHaveProperty("skills");
    } finally {
      vi.useRealTimers();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("records a fetched update once per four hours in its supplied global cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
    const home = await mkdtemp(join(tmpdir(), "acpus-update-awareness-"));
    const cache = join(home, ".acpus", "cache", "update-awareness");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await mkdir(cache, { recursive: true });
    if (process.platform !== "win32") await chmod(cache, 0o755);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      version: "0.8.0",
      engines: { node: ">=22.18.0" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    try {
      await runUpdateAwarenessWorker(["acpus", "0.7.2", cache]);
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000 - 1);
      await runUpdateAwarenessWorker(["acpus", "0.7.2", cache]);

      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await runUpdateAwarenessWorker(["acpus", "0.7.2", cache]);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(await readFile(join(cache, "available.json"), "utf8"))).toMatchObject({
        version: "0.8.0",
        engines: { node: ">=22.18.0" },
      });
      expect(JSON.parse(await readFile(join(cache, "last-attempt.json"), "utf8"))).toHaveProperty("checkedAt");
      if (process.platform !== "win32") {
        expect((await stat(cache)).mode & 0o777).toBe(0o700);
        for (const file of ["available.json", "last-attempt.json"]) {
          expect((await stat(join(cache, file))).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await rm(home, { recursive: true, force: true });
    }
  });
});
