import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const knowledgeFiles = [
  "00-operating-contract.md",
  "10-authoring.md",
  "20-topology.md",
  "30-examples.md",
  "40-execution-recovery.md",
];
const templatePath = `${packageRoot}knowledge/agent.cordis.template.yml`;
const outputPath = `${packageRoot}preset/acpus/agent.cordis.yml`;

const [template, ...modules] = await Promise.all([
  readFile(templatePath, "utf8"),
  ...knowledgeFiles.map(file => readFile(`${packageRoot}knowledge/${file}`, "utf8")),
]);
const knowledge = modules
  .map(module => module.trim())
  .join("\n\n")
  .split("\n")
  .map(line => line === "" ? "" : `      ${line}`)
  .join("\n");
const rendered = `${template.replace(
  "{{ACPUS_SUPERVISOR_KNOWLEDGE}}",
  () => knowledge,
).trimEnd()}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== rendered) {
    console.error("Acpus Supervisor preset is stale. Run 'pnpm --filter @acpus/dsh knowledge:build'.");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, rendered);
}
