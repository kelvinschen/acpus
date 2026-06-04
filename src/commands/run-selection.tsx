import React from "react";
import { render } from "ink";
import { formatRunSummaryList, listRunSummaries } from "../run-index/run-summary.js";
import { printJson } from "./common.js";

export async function resolveOptionalRunArg(input: {
  runArg: string | undefined;
  json?: boolean;
  title: string;
}): Promise<string | undefined> {
  if (input.runArg) return input.runArg;
  if (input.json) {
    printJson(await listRunSummaries());
    return undefined;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(formatRunSummaryList(await listRunSummaries()));
    return undefined;
  }
  return pickRun(input.title);
}

async function pickRun(title: string): Promise<string | undefined> {
  const { RunPickerApp } = await import("../tui/run-picker-app.js");
  let selected: string | undefined;
  const app = render(React.createElement(RunPickerApp, {
    title,
    onSelect: (runId: string | undefined) => {
      selected = runId;
    }
  }));
  await app.waitUntilExit();
  return selected;
}
