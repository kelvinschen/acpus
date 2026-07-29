import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderShellCommand } from "../src/shell-command.js";

describe("shell command rendering", () => {
  it("round-trips exact argv through a POSIX shell", () => {
    const argv = [
      "acpus",
      "runs",
      "inspect",
      "run with space",
      "--target",
      "@123456abcdef",
      "--payload",
      "items[0] '汉字'",
      "",
    ];
    const rendered = renderShellCommand(argv);

    expect(rendered).toBe("acpus runs inspect 'run with space' --target @123456abcdef --payload 'items[0] '\\''汉字'\\''' ''");
    const parsed = spawnSync("sh", ["-c", `set -- ${rendered}; printf '%s\\0' "$@"`], { encoding: "buffer" });
    expect(parsed.status).toBe(0);
    expect(parsed.stdout.toString().split("\0").slice(0, -1)).toEqual(argv);
  });
});
