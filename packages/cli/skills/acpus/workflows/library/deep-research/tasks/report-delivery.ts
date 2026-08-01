/** Research-package assembly and optional Markdown/HTML report delivery Tasks. */
import { task, z, type ArtifactRef } from "acpus/core";
import {
  PrepareReportInputsInput,
  PublishRenderedReportInput,
  WriteResearchPackageInput,
} from "../contracts.js";

const HTML_REPORT_DESIGN = `
# Reader-first deep-research HTML publication contract

Create one self-contained HTML5 research article. It should feel deliberately
edited for a human reader, not exported from a claim database, audit log, or
generic dashboard.

## Editorial north star

- Reader comprehension comes first. Factual correctness and research depth
  support that experience rather than replacing it.
- Answer or orient the reader in the first screen. Infer the likely audience
  from the question and context, establish only the foundations they need, then
  deepen into mechanisms, evidence, comparisons, disagreements, uncertainty,
  and implications.
- Use an adaptive story structure. Do not force a fixed section count, a card per
  claim, or the same template onto every topic.
- Use descriptive headings that state the question answered or conclusion
  reached. Explain terminology before relying on it, and use transitions to
  make the logic between sections visible.
- Place corrections, counter-evidence, and uncertainty beside the conclusion
  they qualify. Keep the full audit trail, verification mechanics, evidence
  ledger, and source index in a clearly separated methods appendix.

## Agent-led publication method

Before finalizing the file, silently complete these passes inside the same
publication turn:

1. Build a concise publication brief: likely reader, prior knowledge, first-screen
   answer, progressive reading path, and the few visuals that would materially
   improve understanding.
2. Write the complete article and all chosen visuals.
3. Re-read the actual draft as a fresh reader. Repair late answers, missing
   definitions, abrupt depth jumps, generic headings, repetitive caveats, weak
   transitions, and claim-by-claim structure.
4. Re-read it as an evidence and visual-integrity editor. Repair unsupported
   wording, misleading scales or arrows, unfair comparisons, weak attribution,
   inaccessible visuals, and any confusion between refutation and proof of the
   logical opposite.
5. Revise the complete file until no material blocker remains. Use the package's
   research depth to bound effort: one review pass for quick, up to two for deep,
   and up to three for xdeep. Do not expose planning or review notes in the
   published article.

## Visual editorial

- Use a visual only when it communicates structure, comparison, sequence,
  magnitude, change, or evidence relationships better than prose.
- Choose the form from the information: compact tables for precise comparison,
  bar or line charts for verified quantitative data, timelines for chronology,
  process diagrams for sequences, architecture diagrams for components and
  interfaces, and evidence maps for agreement, tension, or uncertainty.
- Derive every value, label, node, arrow, sequence, and relationship from the
  research package. Never estimate missing values, invent relationships, or use
  decorative charts to make the report appear richer.
- Place each figure next to the passage it explains. Give it a specific title,
  caption, source note, and useful alt text. Complex visuals also need an
  adjacent prose explanation or readable data table.
- Inline SVG is encouraged for original charts and diagrams. Keep labels legible,
  make scales honest, preserve units and scope, and do not rely on color alone.
- Source images or source figures are optional. Embed one only when its source,
  attribution, and reuse basis are explicit and defensible. Source-media
  retrieval may be used only to obtain that exact visual and rights metadata,
  never to add facts to the research. If retrieval is unavailable or rights are
  unclear, link to the cited source or create an original explanatory visual
  from verified package evidence instead.

## Information architecture and visual system

- Prefer a strong headline, compact deck, first-screen answer, a small set of key
  takeaways, and a continuous main story. Add orientation, glossary, comparison,
  or advanced-detail sections only when the topic benefits from them.
- Navigation may use a restrained sticky rail or compact table of contents when
  the article is long. Do not let navigation or metric tiles dominate the page.
- Use system fonts, a readable measure, generous spacing, restrained borders,
  clear figure treatment, and responsive tables. Choose an editorial palette
  appropriate to the subject with an accessible light or dark presentation;
  avoid gradients, neon, glassmorphism, oversized pills, ornamental animation,
  and repeated card grids.
- Design for a wide desktop canvas but collapse cleanly to one column on narrow
  screens. Include print styles that preserve headings, figures, captions,
  citations, and tables.

## Interaction, accessibility, and delivery

- Use semantic header, nav, main, article, section, figure, figcaption, table,
  details, and footer elements where appropriate. Maintain a valid heading
  hierarchy, visible focus states, sufficient contrast, reduced-motion support,
  and a responsive viewport.
- Theme controls, expandable citations, and the methods appendix must be keyboard
  operable. The article must remain understandable when scripts are disabled.
- Escape all research text before placing it in HTML.
- Use inline CSS, optional inline JavaScript, inline SVG, and data-URI images only.
  Do not use external stylesheets, scripts, fonts, iframes, analytics, runtime
  network calls, or a build step.
- Write exactly one file at the requested draft path and no other files.
`;

const MARKDOWN_REPORT_DESIGN = `
# Reader-first deep-research Markdown publication contract

Create one standalone Markdown research article optimized for careful reading,
review, quotation, and downstream conversion. It should feel deliberately edited
for a human reader, not exported from a claim database or audit log.

## Editorial north star

- Answer or orient the reader early, infer likely prior knowledge from the
  question and context, then move from foundations into mechanisms, evidence,
  comparisons, disagreements, uncertainty, and implications.
- Use an adaptive story structure rather than a fixed section count or one
  heading per claim. Use descriptive headings, explain terms before relying on
  them, and connect sections with real transitions.
- Place corrections and uncertainty beside the conclusion they qualify. Move
  verification mechanics, the evidence ledger, and the source index into a final
  methods-and-evidence appendix.

## Agent-led publication method

Before finalizing, silently plan the reader journey, write the complete article,
then re-read the actual draft from two fresh perspectives: first for reader
comprehension, then for evidence and visual integrity. Revise the full document
until no material blocker remains. Use one review pass for quick research, up to
two for deep, and up to three for xdeep. Do not publish planning or review notes.

## Visual editorial

- Use visuals only when they communicate comparison, chronology, process,
  architecture, magnitude, change, or evidence relationships better than prose.
- Prefer portable Markdown tables for exact comparisons. A fenced Mermaid diagram
  may be used when it materially improves understanding, but include an adjacent
  prose explanation or table fallback because renderer support varies.
- Every number, label, relationship, and sequence must come from the research
  package. Preserve units, scope, and source attribution. Never estimate missing
  values or add decorative diagrams.
- Source images are optional. Include or link one only when source, attribution,
  and reuse basis are explicit. If rights or retrieval are uncertain, cite the
  original source and explain the figure in prose, or create a package-grounded
  table or diagram instead.

## Formatting and delivery

- Use standard Markdown headings, paragraphs, lists, blockquotes, tables,
  footnotes, links, and fenced diagrams where useful. Keep the plain-text form
  readable and avoid raw HTML unless the requested downstream target requires it.
- Put citations beside the claims they support and link only structured source
  URLs from the package. Preserve source titles and quotations when translation
  would damage provenance.
- Write exactly one file at the requested draft path and no other files.
`;

type WriteResearchPackageInput = z.infer<typeof WriteResearchPackageInput>;

/** Writes the format-neutral research package consumed by optional presentation adapters. */
export const writeResearchPackage = task.define({
  inputSchema: WriteResearchPackageInput,
  exec: async ({ input, artifact }): Promise<{ artifact: ArtifactRef }> => {
    const value: WriteResearchPackageInput = input;
    const { readFile } = await import("node:fs/promises");
    const report = JSON.parse(await readFile(artifact.path(value.report), "utf8")) as unknown;
    const evidence = JSON.parse(await readFile(artifact.path(value.ledger), "utf8")) as unknown;
    const file = await artifact.write(
      "research-package.json",
      JSON.stringify({
        schemaVersion: 1,
        runId: value.runId,
        reportLanguage: value.reportLanguage,
        report,
        evidence,
      }, null, 2),
      { mediaType: "application/json" },
    );
    return { artifact: file };
  },
});

type PrepareReportInputsInput = z.infer<typeof PrepareReportInputsInput>;
type PrepareReportInputsResult = {
  format: "md" | "html";
  designSpec: ArtifactRef;
  draftDir: string;
  draftPath: string;
  outputPath: string;
};

/** Resolves format-specific guidance plus safe draft and output paths for a requested report. */
export const prepareReportInputs = task.define({
  inputSchema: PrepareReportInputsInput,
  exec: async ({ input, artifact }): Promise<PrepareReportInputsResult> => {
    const value: PrepareReportInputsInput = input;
    const { chmod, lstat, mkdir } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { extname, isAbsolute, join, relative, resolve, sep } = await import("node:path");
    const delivery = value.format === "html"
      ? {
          design: HTML_REPORT_DESIGN,
          draftName: "index.html",
          defaultPath: `.acpus/reports/${value.runId}/index.html`,
          extension: ".html",
          languageRule: `Use \`${value.reportLanguage}\` for every reader-facing string and for the HTML \`lang\` attribute.`,
        }
      : {
          design: MARKDOWN_REPORT_DESIGN,
          draftName: "report.md",
          defaultPath: `.acpus/reports/${value.runId}/report.md`,
          extension: ".md",
          languageRule: `Use \`${value.reportLanguage}\` for every reader-facing string.`,
        };
    const designSpec = await artifact.write(
      "report-design.md",
      `${delivery.design.trim()}\n\n## Evidence and content boundaries\n\n- Use the research package as the only factual source and preserve its confidence, corrections, refutations, and unresolved evidence.\n- Do not browse for new facts. Narrow retrieval of an exact cited source image or figure is allowed only for source-media delivery and rights checking. If that capability is unavailable, continue without the source image.\n- Link citations only from structured source URL fields in the package. Never infer URLs from prose or turn arbitrary evidence text into a link.\n- Connective, ordering, explanatory, and interpretive sentences over package material are allowed, but do not introduce new entities, dates, quantities, mechanisms, or conclusions.\n- ${delivery.languageRule}\n\n## Reader and prose quality\n\n- Infer the likely reader from the question and context. Give them an answer or useful orientation before asking them to absorb detail.\n- Build from prerequisite concepts to deeper analysis. Explain unfamiliar terms, define scope, and use examples or analogies only when grounded in the package.\n- Adapt the organization to the subject. Do not force a fixed number of sections, bullets, tables, figures, or takeaways.\n- Write in plain, neutral analyst prose with varied sentence and paragraph length. Prefer concrete verbs, named attribution, and descriptive headings over promotional language, generic labels, dramatic fragments, or repetitive caveats.\n- Use tables and visuals as explanations, not decoration. Keep them close to the prose they support and provide a textual equivalent for complex figures.\n- End on the last substantive conclusion, implication, limitation, or open question rather than an upbeat send-off.\n`,
      { mediaType: "text/markdown" },
    );

    const workspaceDir = resolve(value.workspaceDir);
    const acpusHome = resolve(homedir(), ".acpus");
    const draftRoot = resolve(acpusHome, "tmp", "report-drafts");
    const draftDir = resolve(draftRoot, value.runId);
    const relativeDraft = relative(draftRoot, draftDir);
    if (!relativeDraft || relativeDraft === ".." || relativeDraft.startsWith(`..${sep}`) || isAbsolute(relativeDraft)) {
      throw new Error("runId must identify one internal report draft directory.");
    }
    const draftPath = resolve(draftDir, delivery.draftName);
    const requested = value.reportPath.trim();
    const outputPath = resolve(workspaceDir, requested || delivery.defaultPath);
    const relativeOutput = relative(workspaceDir, outputPath);
    if (!relativeOutput || relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) {
      throw new Error("reportPath must resolve to a file inside the workflow workspace.");
    }
    if (extname(outputPath).toLowerCase() !== delivery.extension) {
      throw new Error(`reportPath must end in ${delivery.extension}.`);
    }
    if (outputPath === draftPath) {
      throw new Error("reportPath must not target the internal report draft.");
    }
    for (const directory of [
      acpusHome,
      join(acpusHome, "tmp"),
      draftRoot,
      draftDir,
    ]) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "EEXIST") throw error;
      }
      const item = await lstat(directory);
      if (item.isSymbolicLink() || !item.isDirectory()) {
        throw new Error(`Acpus-owned path '${directory}' is not a regular directory.`);
      }
      if (process.platform !== "win32") await chmod(directory, 0o700);
    }

    return {
      format: value.format,
      designSpec,
      draftDir,
      draftPath,
      outputPath,
    };
  },
});

type PublishRenderedReportInput = z.infer<typeof PublishRenderedReportInput>;
type PublishRenderedReportResult = {
  format: "md" | "html";
  artifact: ArtifactRef;
  path: string;
};

/** Publishes a rendered report idempotently and registers it as a durable artifact. */
export const publishRenderedReport = task.define({
  inputSchema: PublishRenderedReportInput,
  exec: async ({ input, artifact }): Promise<PublishRenderedReportResult> => {
    const value: PublishRenderedReportInput = input;
    const { mkdir, readFile, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const content = await readFile(value.draftPath, "utf8");

    await mkdir(dirname(value.outputPath), { recursive: true });
    try {
      await writeFile(value.outputPath, content, { flag: "wx" });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const existing = await readFile(value.outputPath, "utf8");
      if (existing !== content) throw new Error(`Refusing to replace existing report '${value.outputPath}'.`);
    }
    const report = await artifact.write(
      value.format === "html" ? "deep-research-report.html" : "deep-research-report.md",
      content,
      { mediaType: value.format === "html" ? "text/html" : "text/markdown" },
    );
    return {
      format: value.format,
      artifact: report,
      path: value.outputPath,
    };
  },
});
