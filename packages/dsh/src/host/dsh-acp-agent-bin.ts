#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import * as Acp from "@deepseek-ai/dsh-acp";
import {
  boot,
  installFailLoud,
  loadOverlayPatches,
} from "@deepseek-ai/dsh-app-boot";
import type {} from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

const NAME = "acpus-dsh-acp-agent";
let context: Context | undefined;
let closing: Promise<void> | undefined;

installFailLoud(NAME, process, () => context?.fiber.dispose());

function close(code: number): void {
  closing ??= (async () => {
    try {
      await context?.fiber.dispose();
    } finally {
      process.exit(code);
    }
  })();
}

process.stdin.on("end", () => close(0));
process.on("SIGTERM", () => close(0));
process.on("SIGINT", () => close(130));

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dsh-home": { type: "string" },
      model: { type: "string" },
    },
    strict: true,
  });
  const dshHome = values["dsh-home"];
  if (dshHome === undefined || !isAbsolute(dshHome)) {
    throw new Error("--dsh-home must be an absolute path");
  }
  if (values.model !== undefined && values.model.trim().length === 0) {
    throw new Error("--model must not be empty");
  }
  process.env.DSH_HOME = dshHome;

  const rootConfig = fileURLToPath(new URL("../../acp-agent/cordis.yml", import.meta.url));
  const basePatch = fileURLToPath(
    import.meta.resolve("@deepseek-ai/dsh-base/cordis.patch.yml"),
  );
  context = await boot(
    NAME,
    rootConfig,
    [
      ...loadOverlayPatches(NAME, basePatch),
      { id: "hmr", disabled: true },
    ],
    undefined,
    import.meta.resolve("@deepseek-ai/dsh-base"),
  );

  const defaultModel = context.get("agentDefaultModel") as {
    currentSelection(): {
      provider: string;
      model: string;
      reasoningEffort?: string;
    };
  } | undefined;
  if (defaultModel === undefined) {
    throw new Error("dsh-base did not provide agentDefaultModel");
  }
  const selected = defaultModel.currentSelection();
  const model = values.model ?? selected.model;
  if (selected.reasoningEffort !== undefined && model === selected.model) {
    const reasoningEffort = ReasoningEffortId(selected.reasoningEffort);
    context.on("agent/request", async (_request, next) => ({
      ...await next(),
      reasoningEffort,
    }));
  }
  await context.plugin(Acp, { provider: selected.provider, model });
} catch (error) {
  await context?.fiber.dispose();
  process.stderr.write(
    `${NAME}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
}
