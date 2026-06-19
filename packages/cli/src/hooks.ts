import { Command } from "commander";
import { existsSync } from "node:fs";
import {
  HookConfigLoader,
  globalHookConfigPath,
  projectHookConfigPath,
  isEmptyHookConfig
} from "@acpus/runtime";
import { INJECTOR_NAMES, EVENT_NAMES, type EventHookHandler, type HookConfig, type HookHandler, type InjectorHookHandler } from "@acpus/core";

const EXIT_OK = 0;
const EXIT_FAIL = 1;

interface HandlerDiagnostic {
  injectorOrEvent: string;
  index: number;
  source: "global" | "project";
  ok: boolean;
  message?: string;
}

/** Build the `acpus hooks` command group. */
export function buildHooksCommand(): Command {
  const hooks = new Command("hooks").description("inspect and validate Acpus runtime hooks");

  hooks
    .command("validate")
    .description("validate hook configuration files")
    .option("--global", "validate only the global ~/.acpus/hooks.yaml")
    .option("--project <path>", "validate the project hooks.yaml under <path>")
    .option("--json", "output JSON")
    .action((opts: { global?: boolean; project?: string; json?: boolean }) => {
      const workspace = opts.project ?? process.cwd();
      const loader = new HookConfigLoader(workspace);
      const diagnostics: HandlerDiagnostic[] = [];

      const layers: Array<{ source: "global" | "project"; path: string }> = [];
      if (!opts.project) layers.push({ source: "global", path: globalHookConfigPath() });
      if (!opts.global) layers.push({ source: "project", path: projectHookConfigPath(workspace) });

      let parseError: string | undefined;
      for (const layer of layers) {
        if (!existsSync(layer.path)) continue;
        try {
          const loaded = loader.loadLayer(layer.path);
          validateConfigShape(loaded.config, layer.source, diagnostics);
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
          break;
        }
      }

      const ok = !parseError && diagnostics.every((d) => d.ok);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ok, parseError, diagnostics }, null, 2)}\n`);
      } else if (parseError) {
        process.stderr.write(`Invalid hooks file: ${parseError}\n`);
      } else if (diagnostics.length === 0) {
        process.stdout.write("No hooks configured.\n");
      } else {
        for (const d of diagnostics) {
          const status = d.ok ? "ok" : "error";
          process.stdout.write(`[${status}] ${d.source} ${d.injectorOrEvent}#${d.index}${d.message ? `: ${d.message}` : ""}\n`);
        }
      }
      process.exitCode = ok ? EXIT_OK : EXIT_FAIL;
    });

  hooks
    .command("list")
    .description("show the effective (merged) hook configuration")
    .option("--json", "output JSON")
    .option("--source", "show each handler's source layer")
    .action((opts: { json?: boolean; source?: boolean }) => {
      const loader = new HookConfigLoader(process.cwd());
      const { merged, globalLayer, projectLayer } = loader.load();

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
        process.exitCode = EXIT_OK;
        return;
      }
      if (isEmptyHookConfig(merged)) {
        process.stdout.write("No hooks configured\n");
        process.exitCode = EXIT_OK;
        return;
      }

      const globalCounts = countHandlers(globalLayer.config);
      const lines: string[] = [];
      const renderGroup = (label: string, group: Partial<Record<string, HookHandler[]>>, baseline: Record<string, number>): void => {
        const keys = Object.keys(group);
        if (keys.length === 0) return;
        lines.push(label);
        for (const key of keys) {
          const handlers = group[key] ?? [];
          lines.push(`  ${key}`);
          handlers.forEach((h, i) => {
            const source = opts.source ? ` (${i < (baseline[key] ?? 0) ? "global" : "project"})` : "";
            lines.push(`    - ${describeHandler(h)}${source}`);
          });
        }
      };
      renderGroup("injectors:", merged.injectors ?? {}, globalCounts.injectors);
      renderGroup("events:", merged.events ?? {}, globalCounts.events);
      process.stdout.write(`${lines.join("\n")}\n`);
      process.exitCode = EXIT_OK;
    });

  hooks
    .command("path")
    .description("print global and project hook file paths")
    .option("--global", "print only the global path")
    .action((opts: { global?: boolean }) => {
      const globalPath = globalHookConfigPath();
      const projectPath = projectHookConfigPath(process.cwd());
      const mark = (p: string): string => `${p} ${existsSync(p) ? "(exists)" : "(missing)"}`;
      process.stdout.write(`${mark(globalPath)}\n`);
      if (!opts.global) process.stdout.write(`${mark(projectPath)}\n`);
      process.exitCode = EXIT_OK;
    });

  return hooks;
}

/** Per-group handler counts, used to attribute merged handlers to a source. */
function countHandlers(config: HookConfig): { injectors: Record<string, number>; events: Record<string, number> } {
  const injectors: Record<string, number> = {};
  for (const k of INJECTOR_NAMES) injectors[k] = config.injectors?.[k]?.length ?? 0;
  const events: Record<string, number> = {};
  for (const k of EVENT_NAMES) events[k] = config.events?.[k]?.length ?? 0;
  return { injectors, events };
}

function describeHandler(handler: HookHandler): string {
  return `command: ${handler.command}${handler.timeout ? ` (${handler.timeout})` : ""}`;
}

/** Validate handler field completeness for one config layer. */
function validateConfigShape(config: HookConfig, source: "global" | "project", out: HandlerDiagnostic[]): void {
  const checkGroup = (
    group: Partial<Record<string, HookHandler[]>> | undefined,
    allowed: readonly string[],
    kind: "injector" | "event"
  ): void => {
    for (const [key, handlers] of Object.entries(group ?? {})) {
      const keyOk = allowed.includes(key);
      (handlers ?? []).forEach((handler, index) => {
        const message = validateHandler(handler, kind, keyOk ? undefined : `unknown hook name '${key}'`);
        out.push({ injectorOrEvent: key, index, source, ok: !message, message });
      });
    }
  };
  checkGroup(config.injectors as Partial<Record<string, InjectorHookHandler[]>> | undefined, INJECTOR_NAMES, "injector");
  checkGroup(config.events as Partial<Record<string, EventHookHandler[]>> | undefined, EVENT_NAMES, "event");
}

/** Returns an error message when a handler is malformed, or undefined when valid. */
function validateHandler(handler: HookHandler, kind: "injector" | "event", prefix?: string): string | undefined {
  const errors: string[] = [];
  if (prefix) errors.push(prefix);
  if (!handler || typeof handler !== "object") {
    errors.push("handler must be an object");
    return errors.join("; ");
  }
  const allowedFields = kind === "injector"
    ? new Set(["command", "timeout", "env", "cwd", "on_failure"])
    : new Set(["command", "timeout", "env", "cwd", "sync"]);
  for (const field of Object.keys(handler as unknown as Record<string, unknown>)) {
    if (!allowedFields.has(field)) errors.push(`${field} is not supported`);
  }
  if (typeof handler.command !== "string" || handler.command.length === 0) {
    errors.push("command must be a non-empty string");
  }
  const maybe = handler as HookHandler & { on_failure?: unknown; sync?: unknown; timeout?: unknown; cwd?: unknown; env?: unknown };
  if (maybe.timeout !== undefined && typeof maybe.timeout !== "string") errors.push("timeout must be a string");
  if (maybe.cwd !== undefined && typeof maybe.cwd !== "string") errors.push("cwd must be a string");
  if (maybe.env !== undefined && !isStringRecord(maybe.env)) errors.push("env must be a string map");
  if (kind === "injector") {
    if (maybe.on_failure !== undefined && maybe.on_failure !== "fail" && maybe.on_failure !== "skip") {
      errors.push(`invalid on_failure '${String(maybe.on_failure)}'`);
    }
    if (maybe.sync !== undefined) errors.push("sync is supported only on event handlers");
  } else {
    if (maybe.on_failure !== undefined) errors.push("on_failure is supported only on injector handlers");
    if (maybe.sync !== undefined && typeof maybe.sync !== "boolean") errors.push("sync must be boolean");
  }
  return errors.length > 0 ? errors.join("; ") : undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}
