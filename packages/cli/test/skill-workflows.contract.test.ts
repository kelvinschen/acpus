import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  skillExampleWorkflowPath,
  skillFilePath,
  skillLibraryWorkflowPath,
  skillReferencePath,
  skillWorkflowExamples,
  skillWorkflowLibrary,
  workflowNodeKinds,
} from "./support/skill-workflow-examples.js";

const defaultRouteByteBudget = 12_367;

describe("skill workflow source contracts", () => {
  it("keeps the default authoring route within its fixed context budget", async () => {
    const sources = await Promise.all([
      readFile(skillFilePath("SKILL.md"), "utf8"),
      readFile(skillReferencePath("authoring"), "utf8"),
    ]);
    expect(sources.reduce((bytes, source) => bytes + Buffer.byteLength(source), 0)).toBeLessThanOrEqual(defaultRouteByteBudget);
  });

  it("labels all checked scenario examples and covers every workflow node kind", async () => {
    const covered = new Set<string>();

    for (const example of skillWorkflowExamples) {
      const source = await readFile(skillExampleWorkflowPath(example.directory), "utf8");
      expect(source).toContain(` * Pattern: ${example.pattern}`);
      expect(source).toContain(` * Nodes: ${example.nodes.join(", ")}`);
      for (const node of example.nodes) covered.add(node);
    }

    expect([...covered].sort()).toEqual([...workflowNodeKinds].sort());
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

  it("advertises the workflow library in SKILL without exposing it to authoring routes", async () => {
    const [skill, ...authoringReferences] = await Promise.all([
      readFile(skillFilePath("SKILL.md"), "utf8"),
      ...["authoring", "advanced-authoring", "signal-authoring"]
        .map(name => readFile(skillReferencePath(name), "utf8")),
    ]);

    expect(skill).not.toContain("workflows/README.md");
    expect(skill).toContain("Use library only for a good fit");
    expect(skill).toContain("else follow **Author or adapt**");
    expect(skill).toContain("| Workflow | Use when | Read first |");
    expect(skill).toContain("`/wf:<hint>` / `/workflow:<hint>` mean reuse");
    expect(skill).toContain("Check library/catalog before authoring");
    expect(skill).toContain("otherwise skip catalog");
    expect(authoringReferences.every(reference => !reference.includes("../workflows/library/"))).toBe(true);
    for (const workflow of skillWorkflowLibrary) {
      expect(skill).toContain(
        `| \`${workflow.directory}\` | ${workflow.purpose} | \`workflows/library/${workflow.directory}/README.md\` |`,
      );
      const source = await readFile(skillLibraryWorkflowPath(workflow.directory), "utf8");
      expect(source).not.toContain(" * Pattern:");
      expect(source).not.toContain(" * Nodes:");
    }
  });

  it("documents the deep-research interface and contracts its implementation", async () => {
    const [readme, workflow, contracts, ...taskModules] = await Promise.all([
      readFile(skillLibraryWorkflowPath("deep-research", "README.md"), "utf8"),
      readFile(skillLibraryWorkflowPath("deep-research"), "utf8"),
      readFile(skillLibraryWorkflowPath("deep-research", "contracts.ts"), "utf8"),
      ...[
        "editorial-evidence",
        "evidence-ledger",
        "report-delivery",
        "research-selection",
        "verification",
      ].map(name => readFile(skillLibraryWorkflowPath("deep-research", `tasks/${name}.ts`), "utf8")),
    ]);
    const implementation = [workflow, contracts, ...taskModules].join("\n");
    const [
      editorialEvidence = "",
      evidenceLedger = "",
      reportDelivery = "",
      researchSelection = "",
      verification = "",
    ] = taskModules;
    expect(readme.trimEnd().split("\n").length).toBeLessThanOrEqual(30);
    expect(readme).toContain("Researches a question across public sources");
    for (const input of ["question", "context", "depth", "reportLanguage", "maxAgentConcurrency", "reportFormat", "reportPath"]) {
      expect(readme).toContain(`\`${input}\``);
    }
    expect(readme).toContain("Web Search");
    expect(readme).toContain("Web Fetch");
    expect(readme).toContain("local artifact reads");
    expect(readme).toContain("workspace-scoped report write");
    expect(readme).toContain("workflows/library/deep-research/workflow.ts");
    expect(readme).toContain("always references the format-neutral research package");
    expect(readme).toContain("`report: null`");
    expect(workflow.match(/sessionKey: "deep-research:planner"/g)).toHaveLength(2);
    expect(workflow).toContain('reportLanguage: z.enum(["auto", "zh-CN", "en"]).default("auto")');
    expect(workflow).toContain('reportFormat: z.enum(["none", "md", "html"]).default("html")');
    expect(contracts).not.toContain("PageDraftOutput");
    expect(workflow).toContain('title: "Research inconclusive"');
    expect(workflow).not.toContain("研究结论不足");
    expect(workflow).toContain("Translate deterministic intermediate report text into the resolved report language");
    expect(implementation).not.toContain("publisher manifest source-link count");
    expect(implementation).not.toContain("The HTML lang attribute does not match the resolved report language");
    expect(implementation).not.toContain("The generated HTML report is too small");
    expect(workflow).toContain("quick: { maxSearchRounds: 1, searchWorkers: 1");
    expect(workflow).toContain("standard: { maxSearchRounds: 2, searchWorkers: 2");
    expect(workflow).toContain("deep: { maxSearchRounds: 3, searchWorkers: 3");
    expect(workflow).toContain("const verificationBatchSize = 2");
    expect(workflow).not.toMatch(/searchConcurrency|fetchConcurrency|verificationBatchConcurrency|verificationVoteConcurrency/);
    expect(workflow).toContain('step("batch_search_angles").task');
    expect(workflow).toContain('step("write_planning_brief").task');
    expect(workflow).toContain('step("finish_search_budget").task');
    expect(workflow).toContain('step("verify_initial_batches").fanout');
    expect(workflow).toContain('step("independent_verifiers").parallel');
    expect(workflow).toContain('step("plan_tie_break_batches").task');
    expect(workflow).toContain('step("verify_tie_break_batches").fanout');
    expect(implementation).toContain("coverage mismatch");
    expect(workflow).toContain('step("draft_editorial_bundle").agent');
    expect(workflow).toContain('step("independent_editorial_review").if');
    expect(workflow).toContain('step("review_editorial_bundle").agent');
    expect(workflow).toContain('sessionKey: "deep-research:editor"');
    expect(workflow).toContain('sessionKey: "deep-research:editor-final"');
    expect(contracts).toContain('role: z.enum(["support", "correction", "uncertainty"])');
    expect(workflow).toContain('step("repair_editorial_if_needed").if');
    expect(workflow).toContain('step("repair_editorial").agent');
    expect(implementation).toContain('"pre-editorial-evidence-ledger.json"');
    expect(implementation).toContain('"verified-evidence-ledger.json"');
    expect(implementation).toContain("editorialRepairCalls");
    expect(workflow).toContain('step("write_research_package").task');
    expect(workflow).toContain('step("render_report_if_requested").if');
    expect(workflow).toContain('step("prepare_report_inputs").task');
    expect(workflow).toContain('step("generate_report").agent');
    expect(workflow).toContain('step("publish_report").task');
    expect(workflow).not.toContain('step("generate_html_report")');
    expect(workflow).not.toContain('step("publish_html_report")');
    expect(workflow).not.toContain('step("accept_editorial_draft")');
    expect(workflow).not.toMatch(/step\("generate_report"\)\.agent\(\{\s+outputSchema:/u);
    expect(workflow).toContain("completed: lift(renderer.output, _response => true as const)");
    expect(workflow).toContain('condition: lift(input.reportFormat, format => format !== "none")');
    expect(workflow).toMatch(/else\(\) \{\s+return null;\s+\}/u);
    expect(workflow).toContain("sourcesFetched: lift(selectedSources.output.sources, sources => sources.length)");
    expect(workflow).not.toContain("searchEvidence.output.file");
    expect(workflow).not.toContain("validation.output.violations");
    expect(workflow).not.toContain("budget: finalLedger.output");
    expect(workflow).not.toContain("stats: finalLedger.output");
    expect(workflow).toMatch(/return \{\s+researchPackage: researchPackage\.output\.artifact,\s+report: renderedReport\.output,\s+\};/u);
    expect(contracts).toContain('format: z.enum(["md", "html"])');
    expect(contracts).toContain("completed: z.literal(true)");
    expect(contracts).not.toContain("written: z.literal(true)");
    expect(contracts).not.toContain("disputedClaims: z.array");
    expect(contracts).not.toContain("tieBreakerUsed: z.boolean");
    expect(contracts).not.toContain("vote: z.string");
    expect(editorialEvidence).not.toContain("violations, artifact");
    expect(evidenceLedger).toContain("return { artifact: file, hasConfirmed: confirmed.length > 0 }");
    expect(evidenceLedger).not.toContain("budget: value.budget, stats");
    expect(evidenceLedger).not.toContain("+ (confirmed.length > 0 ? value.budget.editorialPasses : 0)\n        + 1");
    expect(workflow).not.toContain("+ profile.editorialPasses\n          + 1\n          + 1");
    expect(reportDelivery).toContain("export const writeResearchPackage = task.define");
    expect(reportDelivery).toContain("export const prepareReportInputs = task.define");
    expect(reportDelivery).toContain("export const publishRenderedReport = task.define");
    expect(reportDelivery).toContain('"deep-research-report.html" : "deep-research-report.md"');
    expect(reportDelivery).toContain('"text/html" : "text/markdown"');
    expect(reportDelivery).not.toContain("sourceLinkCount");
    expect(reportDelivery).not.toContain("new TextEncoder");
    expect(researchSelection).not.toContain("selectedCount");
    expect(verification).toContain("const disputedClaims = reviews");
    expect(taskModules.every(source => source.includes("task.define"))).toBe(true);
  });
});
