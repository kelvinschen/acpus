import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import parser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import plugin from "../src/internal/eslint-plugin/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturesRoot = join(repoRoot, "packages", "workflow-compiler", "test", "fixtures", "workflows");

describe("internal Acpus ESLint plugin", () => {
  it("reports Expr authoring diagnostics with source locations", async () => {
    const messages = await lintFixture("eslint-expr.workflow.ts");

    expect(codes(messages)).toEqual(expect.arrayContaining(["AL001", "AL003", "AL004", "AL005"]));
    expect(messages.find(message => message.message.startsWith("AL001:"))).toMatchObject({
      ruleId: "acpus-internal/check",
      line: await lineOf("eslint-expr.workflow.ts", "if (!input.ready)"),
    });
  });

  it("reports task-authoring diagnostics at task callsites", async () => {
    const messages = await lintFixture("eslint-task-authoring.workflow.ts");

    expect(codes(messages)).toEqual(expect.arrayContaining(["TB001", "TB003"]));
    expect(messages.find(message => message.message.startsWith("TB001:"))).toMatchObject({
      line: await lineOf("eslint-task-authoring.workflow.ts", 'step("local").task'),
    });
    expect(messages.find(message => message.message.startsWith("TB003:"))).toMatchObject({
      line: await lineOf("eslint-task-authoring.workflow.ts", 'step("inline_capture").task'),
    });
  });

  it("reports fmap authoring diagnostics from the shared check rule", async () => {
    const messages = await lintFixture("eslint-fmap.workflow.ts");
    const callbackMessages = messages.filter(message => message.message.startsWith("AL006:"));

    expect(callbackMessages).toHaveLength(1);
    expect(callbackMessages.find(message => message.message.includes("external binding 'suffix'"))).toMatchObject({
      ruleId: "acpus-internal/check",
      line: await lineOf("eslint-fmap.workflow.ts", "const captured = fmap"),
      message: expect.stringContaining("external binding 'suffix'"),
    });
  });

  it("reports unjoinable Acpus task callsites and ignores unrelated .task methods", async () => {
    const callsiteMessages = await lintFixture("eslint-task-callsite.workflow.ts");
    const nonliteralLine = await lineOf("eslint-task-callsite.workflow.ts", 'step("nonliteral").task');
    const savedLine = await lineOf("eslint-task-callsite.workflow.ts", "saved.task");
    expect(codes(callsiteMessages).filter(code => code === "TB004")).toHaveLength(2);
    expect(callsiteMessages.find(message => message.line === nonliteralLine)).toMatchObject({
      message: expect.stringContaining("object literal"),
    });
    expect(callsiteMessages.find(message => message.line === savedLine)).toMatchObject({
      message: expect.stringContaining('step("id").task'),
    });

    const thirdPartyMessages = await lintFixture("eslint-third-party-task-method.workflow.ts");
    expect(codes(thirdPartyMessages)).not.toContain("TB004");
  });

  it("does not leak diagnostics from unrelated workflow fixtures", async () => {
    const messages = await lintFixture("orchestration.workflow.ts");

    expect(messages).toEqual([]);
  });

  it("reports a clear configuration diagnostic without typed parser services", async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.ts"],
          languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
          },
          plugins: {
            "acpus-internal": plugin,
          },
          rules: {
            "acpus-internal/check": "error",
          },
        },
      ],
    });

    const [result] = await eslint.lintText("export const value = 1;\n", { filePath: join(fixturesRoot, "missing-services.ts") });

    expect(result?.messages).toContainEqual(expect.objectContaining({
      ruleId: "acpus-internal/check",
      message: expect.stringContaining("requires @typescript-eslint/parser with typed parser services"),
    }));
  });
});

async function lintFixture(name: string): Promise<ESLint.LintResult["messages"]> {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser,
          parserOptions: {
            project: "./packages/workflow-compiler/test/tsconfig.json",
            tsconfigRootDir: repoRoot,
            sourceType: "module",
          },
        },
        plugins: {
          "acpus-internal": plugin,
        },
        rules: {
          "acpus-internal/check": "error",
        },
      },
    ],
  });
  const [result] = await eslint.lintFiles([join(fixturesRoot, name)]);
  return result?.messages ?? [];
}

function codes(messages: ESLint.LintResult["messages"]): string[] {
  return messages.map(message => message.message.match(/^([A-Z]+[0-9]+):/)?.[1]).filter(code => code !== undefined);
}

async function lineOf(file: string, text: string): Promise<number> {
  const source = await readFile(join(fixturesRoot, file), "utf8");
  const line = source.split("\n").findIndex(item => item.includes(text));
  expect(line).toBeGreaterThanOrEqual(0);
  return line + 1;
}
