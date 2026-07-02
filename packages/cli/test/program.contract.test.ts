import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";

describe("CLI program usage contracts", () => {
  it("returns structured JSON for commander usage errors", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["bogus", "--json"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      phase: "usage",
    });
    expect(stdout.text).toContain("unknown command");
    expect(stderr.text).toBe("");
  });

  it("accepts global JSON before the command", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["--json", "bogus"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      phase: "usage",
    });
    expect(stderr.text).toBe("");
  });

  it("reports workflow catalog placeholders as inspect failures", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["workflows", "list", "--json"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      phase: "inspect",
      message: "Workflow catalog discovery is not implemented in this version.",
    });
    expect(stderr.text).toBe("");
  });
});
