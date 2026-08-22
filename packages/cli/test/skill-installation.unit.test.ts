import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { parseAcpusSkillMetadata } from "../src/skill/content.js";
import { skillTargets } from "../src/skill/installation.js";

describe("Acpus skill targets", () => {
  it("maps every scope and agent to fixed roots without consulting agent-specific home variables", () => {
    const cwd = resolve("project-root");
    const home = resolve("home-root");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    process.env.CODEX_HOME = resolve("ignored-codex-home");
    process.env.CLAUDE_CONFIG_DIR = resolve("ignored-claude-home");
    try {
      expect(skillTargets(cwd, home, { scope: "project", agents: ["universal", "claude"] })).toEqual([
        {
          scope: "project",
          agent: "universal",
          rootPath: join(cwd, ".agents", "skills"),
          targetPath: join(cwd, ".agents", "skills", "acpus"),
        },
        {
          scope: "project",
          agent: "claude",
          rootPath: join(cwd, ".claude", "skills"),
          targetPath: join(cwd, ".claude", "skills", "acpus"),
        },
      ]);
      expect(skillTargets(cwd, home, { scope: "global", agents: ["claude", "universal"] })).toEqual([
        {
          scope: "global",
          agent: "universal",
          rootPath: join(home, ".agents", "skills"),
          targetPath: join(home, ".agents", "skills", "acpus"),
        },
        {
          scope: "global",
          agent: "claude",
          rootPath: join(home, ".claude", "skills"),
          targetPath: join(home, ".claude", "skills", "acpus"),
        },
      ]);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
    }
  });

});

describe("Acpus skill metadata", () => {
  it("reads the controlled compatibility version from frontmatter metadata", () => {
    expect(parseAcpusSkillMetadata(`---
name: acpus
description: Author Acpus workflows.
metadata:
  acpus-version: 0.6.0-alpha.5
---
`)).toEqual({ name: "acpus", version: "0.6.0-alpha.5" });
  });

  it("keeps older Acpus skills identifiable but unversioned", () => {
    expect(parseAcpusSkillMetadata("---\r\nname: acpus\r\ndescription: Old skill.\r\n---\r\n")).toEqual({ name: "acpus" });
  });

  it("does not interpret unrelated top-level version fields as Acpus metadata", () => {
    expect(parseAcpusSkillMetadata(`---
name: acpus
version: 9.9.9
metadata:
  other-version: 1.0.0
---
`)).toEqual({ name: "acpus" });
  });
});
