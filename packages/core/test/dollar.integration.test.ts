import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createDollar } from "../src/runtime.js";

describe("dollar runtime", () => {
  it("returns command results and reader outputs", async () => {
    const $ = createDollar();
    const result = await $`${process.execPath} -e ${"process.stdout.write('out'); process.stderr.write('err')"}`;

    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.command).toContain(process.execPath);
    expect(result.command).toContain("process.stdout.write");

    await expect($`${process.execPath} -e ${"process.stdout.write('text')"}`.text()).resolves.toBe("text");
    await expect($`${process.execPath} -e ${"process.stdout.write(JSON.stringify({ ok: true }))"}`.json<{ ok: boolean }>()).resolves.toEqual({ ok: true });
    await expect($`${process.execPath} -e ${"process.stdout.write('first\\n\\nsecond\\r\\n')"}`.lines()).resolves.toEqual(["first", "second"]);
  });

  it("supports nonzero exit controls", async () => {
    const $ = createDollar();

    await expect($`${process.execPath} -e ${"process.exit(7)"}`.nothrow()).resolves.toMatchObject({ exitCode: 7 });
    await expect($`${process.execPath} -e ${"process.exit(7)"}`.allowExitCode([7])).resolves.toMatchObject({ exitCode: 7 });
  });

  it("terminates a slow command at an explicit timeout", async () => {
    const $ = createDollar();

    await expect($`${process.execPath} -e ${"setTimeout(() => {}, 10_000)"}`.timeout("100ms")).rejects.toThrow();
  });

  it("does not retain abort listeners after commands complete", async () => {
    const controller = new AbortController();
    const $ = createDollar({ signal: controller.signal });

    await $`${process.execPath} -e ${""}`;

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });
});
