import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { walkNodes, type ExprIR, type NodeVisit, type SchemaIR, type WorkflowIR } from "@acpus/core/ir";
import { prepareWorkflow } from "@acpus/workflow-compiler";
import { describe, expect, it } from "vitest";
import { buildAgentOutputPrompt } from "../../runtime/src/execution/agent-output.js";
import {
  skillExampleWorkflowPath,
  skillFilePath,
  skillLibraryWorkflowPath,
  skillReferencePath,
  skillWorkflowExamples,
} from "./support/skill-workflow-examples.js";

// Bloat ceiling with headroom: keep the default authoring route small enough to
// stay well within an agent's context budget. Raise this only for real content,
// not to accommodate prose reflow. Treat approaching it as a signal to trim docs.
const defaultRouteByteCeiling = 14_000;
const cliPackageRoot = fileURLToPath(new URL("../", import.meta.url));
let deepResearchPreparation: ReturnType<typeof prepareWorkflow> | undefined;
let designForgePreparation: ReturnType<typeof prepareWorkflow> | undefined;
let worktreeTournamentPreparation: ReturnType<typeof prepareWorkflow> | undefined;

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
  });

  it("keeps design-forge semantics in a /tmp text blackboard with resident challenge sessions", async () => {
    const { ir } = await prepareDesignForge();
    expect(ir.diagnostics).toEqual([]);
    expect(ir.name).toBe("design-forge");

    const seed = uniqueNode(ir, "seed_blackboard").node;
    const cycle = uniqueNode(ir, "design_cycle").node;
    const design = uniqueNode(ir, "design_board").node;
    const panel = uniqueNode(ir, "challenge_panel").node;
    const publish = uniqueNode(ir, "publish_blackboard").node;
    const reviewers = [
      {
        name: "fitness",
        gate: uniqueNode(ir, "fitness_gate").node,
        challenge: uniqueNode(ir, "challenge_fitness").node,
      },
      {
        name: "failure",
        gate: uniqueNode(ir, "failure_gate").node,
        challenge: uniqueNode(ir, "challenge_failure").node,
      },
      {
        name: "simplicity",
        gate: uniqueNode(ir, "simplicity_gate").node,
        challenge: uniqueNode(ir, "challenge_simplicity").node,
      },
    ];
    if (
      seed.kind !== "task"
      || cycle.kind !== "loop"
      || design.kind !== "agent"
      || panel.kind !== "parallel"
      || publish.kind !== "task"
    ) {
      throw new Error("design-forge must remain one text-blackboard design loop");
    }

    expect(ir.root.nodes.map(node => [node.id, node.kind])).toEqual([
      ["seed_blackboard", "task"],
      ["design_cycle", "loop"],
      ["publish_blackboard", "task"],
    ]);
    expect(cycle.do.nodes.map(node => [node.id, node.kind])).toEqual([
      ["design_board", "agent"],
      ["challenge_panel", "parallel"],
    ]);
    expect(Object.fromEntries(
      Object.entries(panel.branches).map(([name, branch]) => [
        name,
        branch.nodes.map(node => [node.id, node.kind]),
      ]),
    )).toEqual({
      fitness: [["fitness_gate", "if"]],
      failure: [["failure_gate", "if"]],
      simplicity: [["simplicity_gate", "if"]],
    });
    expect(panel.maxConcurrency).toEqual({ kind: "literal", value: 3 });
    expect(cycle.state).toEqual({
      kind: "object",
      fields: {
        fitnessDone: { kind: "literal", value: false },
        failureDone: { kind: "literal", value: false },
        simplicityDone: { kind: "literal", value: false },
        rounds: { kind: "literal", value: 0 },
      },
    });
    expect(seed.run.input).toEqual({
      kind: "object",
      fields: {
        brief: { kind: "ref", path: ["input", "brief"] },
        runId: { kind: "ref", path: ["meta", "runId"] },
      },
    });
    for (const task of [seed, publish]) {
      if (task.run.target.kind !== "inline") {
        throw new Error("design-forge file operations must remain inline Tasks");
      }
      expect(task.run.target.source).toContain("$`");
      expect(task.run.target.source).not.toContain("node:");
    }
    if (seed.run.target.kind !== "inline" || publish.run.target.kind !== "inline") {
      throw new Error("design-forge file operations must remain inline Tasks");
    }
    expect(seed.run.target.source).toContain("/tmp/acpus-design-forge/");
    expect(seed.run.target.source).toContain("design.md");
    expect(publish.run.target.source).toContain("artifact.write");
    expect(publish.run.target.source).toContain('"text/plain"');
    expect(design.outputSchema).toBeUndefined();
    expect(design.run.cwd).toEqual({
      kind: "ref",
      path: ["nodes", "seed_blackboard", "output", "root"],
    });
    expect(design.run.sessionKey).toBeUndefined();
    expect(templateText(design.run.prompt)).toContain(
      "Write the design and every review response in the task language used by\nbrief.txt.",
    );

    for (const { name, gate, challenge } of reviewers) {
      if (gate.kind !== "if" || challenge.kind !== "agent") {
        throw new Error(`design-forge ${name} branch must gate one Agent`);
      }
      expect(gate.condition).toEqual({
        kind: "ref",
        path: ["loop", "design_cycle", "state", `${name}Done`],
      });
      expect(gate.then.nodes).toEqual([]);
      expect(gate.else.nodes.map(node => [node.id, node.kind])).toEqual([
        [`challenge_${name}`, "agent"],
      ]);
      expect(challenge.outputSchema).toEqual({
        kind: "object",
        additionalProperties: false,
        required: ["done"],
        fields: {
          done: { kind: "boolean" },
        },
      });
      expect(challenge.run.sessionKey).toEqual({
        kind: "literal",
        value: `design-forge:challenger:${name}`,
      });
      expect(challenge.run.cwd).toEqual({
        kind: "ref",
        path: ["nodes", "seed_blackboard", "output", "root"],
      });
      expect(challenge.run.prompt).toMatchObject({
        kind: "template",
        parts: expect.arrayContaining([
          {
            kind: "expr",
            expr: { kind: "ref", path: ["nodes", "design_board", "output"] },
          },
          {
            kind: "expr",
            expr: { kind: "ref", path: ["nodes", "seed_blackboard", "output", "root"] },
          },
        ]),
      });
      expect(templateText(challenge.run.prompt)).toContain(
        "Write your notebook in the task language used by brief.txt.",
      );
      expect(templateText(challenge.run.prompt)).toContain(
        "cannot identify a concrete unresolved issue\nthat could materially change a decision, implementation, operational risk,",
      );
    }

    expect(publish.run.cwd).toEqual({
      kind: "ref",
      path: ["nodes", "seed_blackboard", "output", "root"],
    });
    expect(ir.root.output).toMatchObject({
      kind: "object",
      fields: {
        rounds: { kind: "ref", path: ["nodes", "design_cycle", "output", "rounds"] },
        blackboard: { kind: "ref", path: ["nodes", "publish_blackboard", "output", "blackboard"] },
      },
    });
    if (ir.root.output.kind !== "object") throw new Error("design-forge must return one object");
    expect(Object.keys(ir.root.output.fields)).toEqual(["settled", "rounds", "blackboard"]);
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
      kind: "object",
      fields: {
        result: { kind: "ref", path: ["nodes", "fetch_source", "output"] },
      },
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

  it("renders Result Shape for bundled Agent output schemas", async () => {
    const [{ ir: deepResearch }, { ir: worktreeTournament }] = await Promise.all([
      prepareDeepResearch(),
      prepareWorktreeTournament(),
    ]);

    expect(resultShape(agentOutputSchema(worktreeTournament, "judge_candidates"))).toBe(
      '{ winner: "alpha" | "beta" | "gamma" | "delta" | "epsilon" | "zeta", rationale: string }',
    );
    expect(resultShape(agentOutputSchema(deepResearch, "scope_question"))).toContain(
      "angles: { label: string, query: string, rationale: string }[]",
    );
    expect(resultShape(agentOutputSchema(deepResearch, "search_web"))).toContain(
      "angleIndex: number /* integer; minimum: 0 */",
    );
    expect(resultShape(agentOutputSchema(deepResearch, "verify_claim_batch_a"))).toContain(
      'decision: "supports" | "refutes" | "insufficient"',
    );
    expect(resultShape(agentOutputSchema(deepResearch, "draft_editorial_bundle"))).toContain(
      'kind: "finding" | "correction"',
    );
  });
});

function prepareDeepResearch(): ReturnType<typeof prepareWorkflow> {
  return deepResearchPreparation ??= prepareWorkflow({
    workspaceDir: cliPackageRoot,
    source: {
      kind: "path",
      entry: skillLibraryWorkflowPath("deep-research"),
    },
  });
}

function prepareDesignForge(): ReturnType<typeof prepareWorkflow> {
  return designForgePreparation ??= prepareWorkflow({
    workspaceDir: cliPackageRoot,
    source: {
      kind: "path",
      entry: skillExampleWorkflowPath("design-forge"),
    },
  });
}

function prepareWorktreeTournament(): ReturnType<typeof prepareWorkflow> {
  return worktreeTournamentPreparation ??= prepareWorkflow({
    workspaceDir: cliPackageRoot,
    source: {
      kind: "path",
      entry: skillExampleWorkflowPath("worktree-tournament"),
    },
  });
}

function agentOutputSchema(ir: WorkflowIR, nodeId: string): SchemaIR {
  const match = [...walkNodes(ir.root)].find(({ node }) => node.id === nodeId);
  if (!match || match.node.kind !== "agent" || !match.node.outputSchema) throw new Error(`Expected schema-backed Agent '${nodeId}'.`);
  return match.node.outputSchema;
}

function resultShape(schema: SchemaIR): string {
  const prompt = buildAgentOutputPrompt("task", schema);
  const match = prompt.match(/<ACPUS_OUTPUT>\n([\s\S]*)\n<\/ACPUS_OUTPUT>$/u);
  if (!match) throw new Error("Expected a Result Shape handoff.");
  return match[1]!;
}

function templateText(expression: ExprIR): string {
  if (expression.kind !== "template") throw new Error("Expected a template expression.");
  return expression.parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
    .map(part => part.value)
    .join("");
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
