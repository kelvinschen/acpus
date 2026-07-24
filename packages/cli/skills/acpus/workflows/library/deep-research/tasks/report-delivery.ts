/** Research-package assembly and optional Markdown/HTML report delivery Tasks. */
import { task, z, type ArtifactRef } from "acpus/core";
import {
  PrepareReportInputsInput,
  PublishRenderedReportInput,
  WriteResearchPackageInput,
} from "../contracts.js";

const HTML_REPORT_DESIGN = `
# Deep-research HTML design contract

Create one self-contained HTML5 document. The visual direction is an editorial
research article: quiet, authoritative, information-dense, and designed for
long-form reading rather than a generic dashboard.

## Information architecture

- A sticky left rail identifies the report, links to every major section, and
  contains the theme control.
- The hero uses an editorial headline, a short deck, provenance chips, and a
  compact metric panel. Include research depth, research Agent calls versus the
  configured ceiling, search worker/planning calls, sources fetched, verifier
  Agent calls versus claim-level votes, tie-breaker calls, and editorial repairs.
- The main story contains executive summary, findings, tensions or contrary
  evidence, corrections to refuted claims, unresolved evidence, implications,
  limitations, open questions, methodology, evidence ledger, and source index
  sections when the data supports them.
- Put citations beside the claims they support. Link only URLs stored in
  structured source fields. Never turn arbitrary evidence text into links.
- Keep refuted and unverified claims visible as transparency records, clearly
  separated from confirmed findings.
- Present correction-role evidence as a correction to the original wording,
  never as automatic proof that the logical negation is true.

## Visual system

- Default to a deep navy background (#0d1724), slightly lighter panels
  (#162231), warm ivory text (#f1eadc), muted sand text (#aaa08e), and restrained
  amber accents (#d6aa55). Provide an accessible light theme with the same
  hierarchy.
- Use a serif display face from the local system stack for titles and a highly
  readable serif or sans-serif system stack for body text. Do not load fonts.
- Use generous whitespace, thin low-contrast borders, numbered cards, callout
  bands, compact metric tiles, and readable tables. Avoid gradients, neon,
  glassmorphism, oversized pills, decorative charts, and ornamental animation.
- Target a 1440px editorial canvas with a roughly 250px rail and a centered
  reading column. Collapse to one column below 900px.

## Interaction and accessibility

- Include a keyboard-operable dark/light theme toggle and persist the choice in
  localStorage.
- Highlight the active section while scrolling when practical.
- Use semantic header, nav, main, section, article, table, and footer elements;
  visible focus states; sufficient contrast; reduced-motion support; and a
  responsive viewport declaration.

## Delivery constraints

- Escape all research text before placing it in HTML.
- Use only inline CSS and optional inline JavaScript. No external stylesheets,
  scripts, fonts, images, iframes, analytics, network calls, or build step.
- Write exactly one file at the requested draft path and no other files.
`;

const MARKDOWN_REPORT_DESIGN = `
# Deep-research Markdown design contract

Create one standalone Markdown document optimized for careful reading, review,
quotation, and downstream conversion to other presentation formats.

## Information architecture

- Start with the report title, deck, and a compact provenance block.
- Include executive summary, findings, tensions or contrary evidence,
  corrections, unresolved evidence, implications, limitations, open questions,
  research methodology, evidence ledger, and source index when supported by the
  package.
- Keep confirmed, refuted, and unverified claims visibly distinct.
- Put linked citations beside the claims they support. Link only structured
  source URLs from the package.
- Include research depth, research Agent calls versus the configured ceiling,
  search and verification activity, tie-breakers, and editorial repairs in the
  methodology section.

## Formatting

- Use standard Markdown headings, paragraphs, lists, blockquotes, tables, and
  links. Avoid raw HTML and renderer-specific extensions.
- Keep tables compact enough to remain readable as plain text.
- Preserve quotations and source titles exactly when translation would damage
  provenance.
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
      `${delivery.design.trim()}\n\n## Content constraints\n\n- Use the research package as the only content source.\n- Do not browse, invent facts, alter conclusions, or add citations absent from the package.\n- ${delivery.languageRule}\n`,
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
