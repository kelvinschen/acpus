import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  createUpdateAwareness,
  formatUpdateNotice,
  isAvailableUpdate,
  isUpdateAwarenessEligible,
  isUpdateCheckDue,
  runUpdateAwarenessWorker,
} from "../src/update-awareness.js";
import { CaptureStream } from "./support/capture-stream.js";

class TtyCaptureStream extends CaptureStream {
  isTTY = true;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("update awareness", () => {
  it("runs only for interactive text command actions outside automated environments", () => {
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
    expect(isUpdateAwarenessEligible({ ...input, argv: ["workflow", "catalog", "--json"] })).toBe(false);
    expect(isUpdateAwarenessEligible({ ...input, argv: ["workflow", "catalog", "--help"] })).toBe(false);
    expect(isUpdateAwarenessEligible({ ...input, topLevelCommand: "doctor", argv: ["doctor"] })).toBe(true);
    expect(isUpdateAwarenessEligible({ ...input, topLevelCommand: "doctor", argv: ["doctor", "--json"] })).toBe(false);
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

  it("waits a full day before another remote attempt", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");

    expect(isUpdateCheckDue(undefined, now)).toBe(true);
    expect(isUpdateCheckDue("2026-07-23T11:59:59.999Z", now)).toBe(false);
    expect(isUpdateCheckDue("2026-07-22T12:00:00.000Z", now)).toBe(true);
  });

  it("uses the interactive Skill refresh command", () => {
    expect(formatUpdateNotice({
      currentVersion: "0.7.2",
      update: { checkedAt: "2026-07-23T00:00:00.000Z", version: "0.8.0" },
      needsSkillRefresh: true,
      color: false,
    })).toBe([
      "Update available: acpus 0.7.2 → 0.8.0",
      "Run: npm install -g acpus@latest",
      "Refresh skill: acpus skill install",
      "",
    ].join("\n"));
  });

  it("emphasizes update actions in a color terminal", () => {
    expect(formatUpdateNotice({
      currentVersion: "0.7.2",
      update: { checkedAt: "2026-07-23T00:00:00.000Z", version: "0.8.0" },
      needsSkillRefresh: true,
      color: true,
    })).toBe([
      "\u001b[1;33mUpdate available:\u001b[0m acpus 0.7.2 → 0.8.0",
      "\u001b[1;33mRun:\u001b[0m \u001b[1;36mnpm install -g acpus@latest\u001b[0m",
      "\u001b[1;33mRefresh skill:\u001b[0m \u001b[1;36macpus skill install\u001b[0m",
      "",
    ].join("\n"));
  });

  it("does not append a Doctor notice after a failed Doctor run", async () => {
    const home = await mkdtemp(join(tmpdir(), "acpus-update-awareness-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const cache = join(home, ".acpus", ".local", "update-awareness");
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
        cwd: home,
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

  it("records a fetched update once per day in its supplied global cache", async () => {
    const cache = await mkdtemp(join(tmpdir(), "acpus-update-awareness-"));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      version: "0.8.0",
      engines: { node: ">=22.18.0" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    try {
      await runUpdateAwarenessWorker(["acpus", "0.7.2", cache]);
      await runUpdateAwarenessWorker(["acpus", "0.7.2", cache]);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(join(cache, "available.json"), "utf8"))).toMatchObject({
        version: "0.8.0",
        engines: { node: ">=22.18.0" },
      });
      expect(JSON.parse(await readFile(join(cache, "last-attempt.json"), "utf8"))).toHaveProperty("checkedAt");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
