import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { walkNodes, type NodeVisit, type WorkflowIR } from "@acpus/core/ir";
import { prepareWorkflow } from "@acpus/workflow-compiler";
import { describe, expect, it } from "vitest";
import {
  skillFilePath,
  skillLibraryWorkflowPath,
  skillReferencePath,
  skillWorkflowExamples,
  skillWorkflowLibrary,
} from "./support/skill-workflow-examples.js";

// Bloat ceiling with headroom: keep the default authoring route small enough to
// stay well within an agent's context budget. Raise this only for real content,
// not to accommodate prose reflow. Treat approaching it as a signal to trim docs.
const defaultRouteByteCeiling = 14_000;
const cliPackageRoot = fileURLToPath(new URL("../", import.meta.url));
let deepResearchPreparation: ReturnType<typeof prepareWorkflow> | undefined;

describe("skill workflow contracts", () => {
  it("keeps the default authoring route within its fixed context budget", async () => {
    const sources = await Promise.all([
      readFile(skillFilePath("SKILL.md"), "utf8"),
      readFile(skillReferencePath("authoring"), "utf8"),
    ]);
    expect(sources.reduce((bytes, source) => bytes + Buffer.byteLength(source), 0)).toBeLessThanOrEqual(defaultRouteByteCeiling);
  });

  it("does not publish symlinks, special files, or invalid UTF-8 skill resources", async () => {
    const root = skillFilePath("");
    const resources = await walkSkillResources(root);

    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      const stats = await lstat(resource.path);
      expect(stats.isSymbolicLink(), resource.relativePath).toBe(false);
      expect(stats.isDirectory() || stats.isFile(), resource.relativePath).toBe(true);
      if (stats.isFile()) {
        const content = await readFile(resource.path);
        expect(() => new TextDecoder("utf-8", { fatal: true }).decode(content)).not.toThrow();
      }
    }
  });

  it("routes each example from exactly one disclosure layer", async () => {
    const references = await Promise.all(
      ["authoring", "advanced-authoring", "signal-authoring"].map(async name => ({
        name,
        source: await readFile(skillReferencePath(name), "utf8"),
      })),
    );
    for (const example of skillWorkflowExamples) {
      const link = `../workflows/examples/${example.directory}/workflow.ts`;
      const routes = references.filter(reference => reference.source.includes(link)).map(reference => reference.name);
      expect(routes, example.name).toEqual([example.reference]);
    }
  });

  it("advertises the workflow library without exposing it to authoring routes", async () => {
    const [skill, ...authoringReferences] = await Promise.all([
      readFile(skillFilePath("SKILL.md"), "utf8"),
      ...["authoring", "advanced-authoring", "signal-authoring"]
        .map(name => readFile(skillReferencePath(name), "utf8")),
    ]);

    expect(skill).toContain("/wf:");
    expect(skill).toContain("/workflow:");
    expect(authoringReferences.every(reference => !reference.includes("../workflows/library/"))).toBe(true);
    for (const workflow of skillWorkflowLibrary) {
      expect(libraryReadmeCell(skill, workflow.directory), workflow.directory)
        .toBe(`\`workflows/library/${workflow.directory}/README.md\``);
    }
  });

  it("prepares deep-research and keeps its documented inputs aligned", async () => {
    const [readme, { ir }] = await Promise.all([
      readFile(skillLibraryWorkflowPath("deep-research", "README.md"), "utf8"),
      prepareDeepResearch(),
    ]);
    // Scannability ceiling, not a line lock: a library README must stay short
    // enough to skim, with headroom for ordinary wording edits.
    expect(readme.trimEnd().split("\n").length).toBeLessThanOrEqual(45);
    expect(ir.diagnostics).toEqual([]);
    expect(ir.name).toBe("deep-research");

    const inputSchema = ir.inputSchema;
    if (inputSchema?.kind !== "object") throw new Error("deep-research must have an object input schema");
    expect(documentedInputNames(readme)).toEqual(Object.keys(inputSchema.fields));
    expect(inputSchema).toMatchObject({
      required: ["question"],
      additionalProperties: false,
      fields: {
        question: { kind: "string" },
        context: { kind: "string", default: "" },
        depth: { kind: "enum", values: ["quick", "deep", "xdeep"], default: "deep" },
        reportLanguage: { kind: "enum", values: ["auto", "zh-CN", "en"], default: "auto" },
        maxAgentConcurrency: { kind: "number", default: 12 },
        reportFormat: { kind: "enum", values: ["none", "md", "html"], default: "html" },
        reportPath: { kind: "string", default: "" },
      },
    });
  });

  it("contracts deep-research's durable boundary and fetch dataflow in WorkflowIR", async () => {
    const { ir } = await prepareDeepResearch();
    expect(ir.root.output).toEqual({
      kind: "object",
      fields: {
        researchPackage: { kind: "ref", path: ["nodes", "write_research_package", "output", "artifact"] },
        report: { kind: "ref", path: ["nodes", "render_report_if_requested", "output"] },
      },
    });

    const fetch = uniqueNode(ir, "fetch_source");
    const fetchGate = uniqueNode(ir, "require_fetch_tool");
    expect(fetch.ancestry.map(({ kind, owner }) => [kind, owner.id])).toEqual([["fanout", "fetch_sources"]]);
    expect(fetchGate.ancestry.map(({ kind, owner }) => [kind, owner.id])).toEqual([["fanout", "fetch_sources"]]);
    if (fetch.node.kind !== "agent" || fetchGate.node.kind !== "task") {
      throw new Error("deep-research fetch pipeline must be Agent -> Task");
    }
    expect(fetch.node).toMatchObject({
      outputSchema: {
        kind: "object",
        fields: {
          status: { kind: "enum", values: ["ok", "tool_unavailable"] },
          sourceQuality: { kind: "enum", values: ["primary", "secondary", "blog", "forum", "unreliable"] },
          claims: { kind: "array" },
        },
      },
      run: {
        agent: "fetcher",
        cwd: { kind: "ref", path: ["meta", "workspaceDir"] },
        prompt: {
          kind: "template",
          parts: expect.arrayContaining([
            { kind: "expr", expr: { kind: "ref", path: ["fanout", "fetch_sources", "item", "url"] } },
          ]),
        },
      },
    });
    expect(fetchGate.node.run.input).toEqual({
      result: { kind: "ref", path: ["nodes", "fetch_source", "output"] },
    });

    const fetchScope = fetch.ancestry[0];
    if (fetchScope?.kind !== "fanout") throw new Error("fetch_source must belong to fetch_sources");
    expect(fetchScope.scope.output).toMatchObject({
      kind: "object",
      fields: {
        sourceQuality: { kind: "ref", path: ["nodes", "require_fetch_tool", "output", "sourceQuality"] },
        claims: { kind: "ref", path: ["nodes", "require_fetch_tool", "output", "claims"] },
      },
    });

    const report = uniqueNode(ir, "render_report_if_requested").node;
    if (report.kind !== "if") throw new Error("render_report_if_requested must remain conditional");
    expect(report.else).toEqual({ nodes: [], output: { kind: "literal", value: null } });
    expect(report.then.nodes.map(node => [node.id, node.kind])).toEqual([
      ["prepare_report_inputs", "task"],
      ["generate_report", "agent"],
      ["publish_report", "task"],
    ]);
  });
});

function prepareDeepResearch(): ReturnType<typeof prepareWorkflow> {
  return deepResearchPreparation ??= prepareWorkflow({
    workflow: skillLibraryWorkflowPath("deep-research"),
    cwd: cliPackageRoot,
  });
}

function documentedInputNames(markdown: string): string[] {
  const marker = "## Inputs\n";
  const start = markdown.indexOf(marker);
  if (start < 0) return [];
  const bodyStart = start + marker.length;
  const nextHeading = markdown.indexOf("\n## ", bodyStart);
  const section = markdown.slice(bodyStart, nextHeading < 0 ? undefined : nextHeading);
  return [...section.matchAll(/^- `([^`]+)`/gmu)].map(match => match[1]!);
}

function libraryReadmeCell(skill: string, directory: string): string | undefined {
  const row = skill.split("\n").find(line => line.trimStart().startsWith(`| \`${directory}\``));
  if (row === undefined) return undefined;
  return row.split("|").map(cell => cell.trim())[3];
}

function uniqueNode(ir: WorkflowIR, id: string): NodeVisit {
  const matches = [...walkNodes(ir.root)].filter(({ node }) => node.id === id);
  if (matches.length !== 1) throw new Error(`Expected exactly one '${id}' node, found ${matches.length}.`);
  return matches[0]!;
}


async function walkSkillResources(
  root: string,
  relativePath = "",
): Promise<Array<{ path: string; relativePath: string }>> {
  const entries = await readdir(join(root, relativePath));
  const resources: Array<{ path: string; relativePath: string }> = [];
  for (const name of entries.sort()) {
    const childRelative = relativePath.length === 0 ? name : `${relativePath}/${name}`;
    const path = join(root, childRelative);
    const stats = await lstat(path);
    resources.push({ path, relativePath: childRelative });
    if (stats.isDirectory()) resources.push(...await walkSkillResources(root, childRelative));
  }
  return resources;
}
