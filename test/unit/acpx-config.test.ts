import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAcpxAgentOverrides, parseAgentOverrides } from "../../src/runtime/acpx-config.js";

describe("acpx config loading", () => {
  it("parses agent command overrides with args like acpx CLI config", () => {
    expect(parseAgentOverrides({
      agents: {
        Aiden: { command: "aiden acp" },
        custom: { command: "node ./agent.js", args: ["--profile", "ci mode"] }
      }
    })).toEqual({
      aiden: "aiden acp",
      custom: "node ./agent.js \"--profile\" \"ci mode\""
    });
  });

  it("merges global and project agent overrides with project precedence", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-home-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-project-"));
    await fs.mkdir(path.join(home, ".acpx"));
    await fs.writeFile(path.join(home, ".acpx", "config.json"), JSON.stringify({
      agents: {
        aiden: { command: "aiden acp" },
        claude: { command: "global-claude" }
      }
    }), "utf8");
    await fs.writeFile(path.join(cwd, ".acpxrc.json"), JSON.stringify({
      agents: {
        claude: { command: "project-claude" }
      }
    }), "utf8");

    await expect(loadAcpxAgentOverrides(cwd, { homeDir: home })).resolves.toEqual({
      aiden: "aiden acp",
      claude: "project-claude"
    });
  });
});
