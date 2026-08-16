import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-tool/client";
import TYPERT_REMOTE from "../remote/generated.js";
import {
  AcpusActivityTray,
  AcpusInternalToolView,
} from "./activity-tray.js";
import { AcpusBrandLabel, AcpusProfileAction } from "./profile-action.js";
import { AcpusClientState, type AcpusRemote } from "./state.js";
import activityTrayStyles from "./activity-tray.css";
import profileActionStyles from "./profile-action.css";

export const inject = ["slots", "remote"];

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const removeStyles = installStyles();
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
  const remote = ctx.get("remote.acpus") as AcpusRemote | undefined;
  if (remote === undefined) {
    await disposeRemote();
    removeStyles();
    throw new Error("Acpus Remote namespace was not mounted.");
  }
  const acpus = new AcpusClientState(remote);
  const dispose = ctx.effect(() => {
    const entries = [
      ...ACPUS_TOOL_NAMES.map(key =>
        ctx.slots.inject("tool.call.toolview", () => ctx.slots.register(
          { name: "tool.call.toolview", key },
        AcpusInternalToolView,
      ))),
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
        {
          name: "conversation.session.header.actions",
          id: "acpus-dsh-brand",
          order: -9,
        },
        AcpusBrandLabel,
      )),
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
        {
          name: "conversation.session.header.actions",
          id: "acpus-agent-profiles",
          order: 0,
          inject: () => ({ acpus }),
        },
        AcpusProfileAction,
      )),
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
        {
          name: "conversation.input.dock",
          id: "acpus-runs",
          order: 15,
          inject: () => ({ acpus }),
        },
        AcpusActivityTray,
      )),
    ];
    return () => {
      for (const remove of entries.reverse()) remove();
      acpus.dispose();
    };
  }, "acpus.client");
  return async () => {
    await dispose();
    await disposeRemote();
    removeStyles();
  };
}

function installStyles(): () => void {
  const clientDocument = (globalThis as unknown as { document?: ClientDocument }).document;
  if (clientDocument === undefined) return () => {};
  const existing = clientDocument.querySelector("style[data-acpus-activity-styles]");
  if (existing) return () => {};
  const style = clientDocument.createElement("style");
  style.dataset.acpusActivityStyles = "";
  style.textContent = `${activityTrayStyles}\n${profileActionStyles}`;
  clientDocument.head.append(style);
  return () => style.remove();
}

type ClientStyleElement = {
  dataset: Record<string, string>;
  textContent: string | null;
  remove(): void;
};

type ClientDocument = {
  querySelector(selector: string): ClientStyleElement | null;
  createElement(tag: "style"): ClientStyleElement;
  head: { append(element: ClientStyleElement): void };
};

const ACPUS_TOOL_NAMES = [
  "acpus_profiles",
  "acpus_tasks",
  "acpus_run",
  "acpus_inspect",
  "acpus_control",
  "acpus_artifact",
] as const;

export { AcpusActivityTray, AcpusInternalToolView } from "./activity-tray.js";
export { AcpusProfileAction } from "./profile-action.js";
export { AcpusClientState } from "./state.js";
