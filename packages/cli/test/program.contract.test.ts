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
});
