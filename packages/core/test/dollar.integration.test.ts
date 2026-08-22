import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { $ as zxDollar, quote, quotePowerShell } from "zx/core";
import { createDollar } from "../src/runtime.js";

describe("dollar runtime", () => {
  it("resolves live process defaults after wrapper creation", async () => {
    const $ = createDollar();
    const root = await mkdtemp(join(tmpdir(), "acpus-dollar-live-"));
    const cwd = join(root, "cwd");
    const previousCwd = process.cwd();
    const previousMarker = process.env.ACPUS_DOLLAR_MARKER;
    await mkdir(cwd);
    try {
      process.chdir(cwd);
      process.env.ACPUS_DOLLAR_MARKER = "live";

      const output = await $`${process.execPath} -e ${"process.stdout.write(JSON.stringify({ cwd: process.cwd(), marker: process.env.ACPUS_DOLLAR_MARKER }))"}`
        .json<{ cwd: string; marker: string }>();

      expect(output).toEqual({ cwd, marker: "live" });
    } finally {
      process.chdir(previousCwd);
      if (previousMarker === undefined) delete process.env.ACPUS_DOLLAR_MARKER;
      else process.env.ACPUS_DOLLAR_MARKER = previousMarker;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges chained command configuration and applies the latest overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-dollar-config-"));
    const first = join(root, "first");
    const second = join(root, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    try {
      const configured = createDollar()({
        cwd: first,
        env: { ...process.env, ACPUS_DOLLAR_MARKER: "configured" },
      })({ cwd: second });
      const output = await configured`${process.execPath} -e ${"process.stdout.write(JSON.stringify({ cwd: process.cwd(), marker: process.env.ACPUS_DOLLAR_MARKER }))"}`
        .json<{ cwd: string; marker: string }>();

      expect(output).toEqual({ cwd: second, marker: "configured" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns command results and reader outputs", async () => {
    const $ = createDollar();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await $`${process.execPath} -e ${"process.stdout.write('out'); process.stderr.write('err')"}`;
      expect(result.stdout).toBe("out");
      expect(result.stderr).toBe("err");
      expect(stderr).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeUndefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.command).toContain(process.execPath);
      expect(result.command).toContain("process.stdout.write");
    } finally {
      stderr.mockRestore();
    }

    await expect($`${process.execPath} -e ${"process.stdout.write('text')"}`.text()).resolves.toBe("text");
    await expect($`${process.execPath} -e ${"process.stdout.write(JSON.stringify({ ok: true }))"}`.json<{ ok: boolean }>()).resolves.toEqual({ ok: true });
    await expect($`${process.execPath} -e ${"process.stdout.write('first\\n\\nsecond\\r\\n')"}`.lines()).resolves.toEqual(["first", "second"]);
  });

  it("reports the command that zx executes for array interpolation", async () => {
    const $ = createDollar();
    const source = "process.stdout.write(process.argv.slice(1).join('|'))";
    const args = ["a b", "c"];
    const result = await $`${process.execPath} -e ${source} ${args}`;

    expect(result.stdout).toBe("a b|c");
    const quoteArg = process.platform === "win32" ? quotePowerShell : quote;
    expect(result.command).toBe([process.execPath, "-e", source, ...args].map(quoteArg).join(" "));
  });

  it("supports nonzero exit controls", async () => {
    const $ = createDollar();

    await expect($`${process.execPath} -e ${"process.exit(7)"}`.nothrow()).resolves.toMatchObject({ exitCode: 7 });
    await expect($`${process.execPath} -e ${"process.exit(7)"}`.allowExitCode([7])).resolves.toMatchObject({ exitCode: 7 });
  });

  it("terminates a command tree at an explicit timeout without changing zx globally", async () => {
    const $ = createDollar();
    const originalKill = zxDollar.kill;
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    const source = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore' });",
      "process.stdout.write(String(child.pid));",
      "setTimeout(() => {}, 10_000);",
    ].join("");
    let childPid: number | undefined;
    process.on("warning", onWarning);

    try {
      let failure: unknown;
      try {
        await $`${process.execPath} -e ${source}`.timeout("100ms");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ signal: "SIGTERM" });
      const parsedChildPid = Number((failure as { stdout: string }).stdout);
      expect(Number.isSafeInteger(parsedChildPid) && parsedChildPid > 0).toBe(true);
      childPid = parsedChildPid;
      await vi.waitFor(() => expect(isProcessAlive(childPid!)).toBe(false));
    } finally {
      process.off("warning", onWarning);
      if (childPid !== undefined && isProcessAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
    }
    expect(zxDollar.kill).toBe(originalKill);
    expect(warnings.filter(warning => (warning as NodeJS.ErrnoException).code === "DEP0190")).toEqual([]);
  });

  it("does not retain abort listeners after commands complete", async () => {
    const controller = new AbortController();
    const $ = createDollar({ signal: controller.signal });

    await $`${process.execPath} -e ${""}`;

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });
});

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
