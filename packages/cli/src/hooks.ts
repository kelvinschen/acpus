import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  HookConfigLoader,
  globalHookConfigPath,
  projectHookConfigPath,
  isEmptyHookConfig
} from "@acpus/runtime";
import { INJECTOR_NAMES, EVENT_NAMES, validateHookConfigShape, type HookConfig, type HookHandler } from "@acpus/core";

const EXIT_OK = 0;
const EXIT_FAIL = 1;

interface HandlerDiagnostic {
  injectorOrEvent: string;
  index?: number;
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
      const diagnostics: HandlerDiagnostic[] = [];

      const layers: Array<{ source: "global" | "project"; path: string }> = [];
      if (!opts.project) layers.push({ source: "global", path: globalHookConfigPath() });
      if (!opts.global) layers.push({ source: "project", path: projectHookConfigPath(workspace) });

      let parseError: string | undefined;
      for (const layer of layers) {
        if (!existsSync(layer.path)) continue;
        try {
          validateConfigShape(readHookConfigForValidation(layer.path), layer.source, diagnostics);
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
          const index = d.index === undefined ? "" : `#${d.index}`;
          process.stdout.write(`[${status}] ${d.source} ${d.injectorOrEvent}${index}${d.message ? `: ${d.message}` : ""}\n`);
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
  const configured = configuredHandlers(config);
  for (const handler of configured) {
    out.push({ ...handler, source, ok: true });
  }
  for (const issue of validateHookConfigShape(config)) {
    const injectorOrEvent = issue.hookName ?? issue.path ?? "$";
    const existing = issue.handlerIndex === undefined ? undefined : out.find((item) =>
      item.source === source &&
      item.injectorOrEvent === injectorOrEvent &&
      item.index === issue.handlerIndex
    );
    if (existing) {
      existing.ok = false;
      existing.message = existing.message ? `${existing.message}; ${issue.message}` : issue.message;
    } else {
      out.push({ injectorOrEvent, index: issue.handlerIndex, source, ok: false, message: issue.message });
    }
  }
}

function readHookConfigForValidation(path: string): HookConfig {
  const raw = readFileSync(path, "utf8").trim();
  return raw.length === 0 ? {} : parseYaml(raw) as HookConfig;
}

function configuredHandlers(config: HookConfig): Array<Omit<HandlerDiagnostic, "source">> {
  const out: Array<Omit<HandlerDiagnostic, "source">> = [];
  for (const [key, handlers] of Object.entries(config.injectors ?? {})) {
    if (Array.isArray(handlers)) handlers.forEach((_, index) => out.push({ injectorOrEvent: key, index, ok: true }));
  }
  for (const [key, handlers] of Object.entries(config.events ?? {})) {
    if (Array.isArray(handlers)) handlers.forEach((_, index) => out.push({ injectorOrEvent: key, index, ok: true }));
  }
  return out;
}
