import { describe, expect, it } from "vitest";
import { parseAcpusSkillMetadata } from "../src/skill-installation.js";

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
