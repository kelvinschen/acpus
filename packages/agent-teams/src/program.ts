import type { Readable, Writable } from "node:stream";
import { Command, CommanderError, Option } from "commander";
import * as Effect from "effect/Effect";
import { executeTeamCliIntent, type TeamCliIntent } from "./commands.js";

export type TeamCliContext = Readonly<{
  cwd: string;
  cliPath: string;
  env: Readonly<NodeJS.ProcessEnv>;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  webObserver?: Readonly<{
    markSettled(): void;
    waitForClose(): Promise<void>;
  }>;
}>;

export function runCli(argv: readonly string[], context: TeamCliContext): Effect.Effect<number> {
  return Effect.suspend(() => {
    const parsed = parseIntent(argv, context);
    if (parsed.type === "exit") return Effect.succeed(parsed.code);
    if (parsed.type === "error") {
      context.stderr.write(`${parsed.message}\n`);
      return Effect.succeed(2);
    }
    return executeTeamCliIntent(parsed.intent, context).pipe(
      Effect.tap(result => Effect.sync(() => {
        if (result.output !== undefined) context.stdout.write(`${JSON.stringify(result.output, undefined, 2)}\n`);
      })),
      Effect.map(result => result.exitCode),
      Effect.catch(error => Effect.sync(() => {
        context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      })),
    );
  });
}

type ParseResult =
  | Readonly<{ type: "intent"; intent: TeamCliIntent }>
  | Readonly<{ type: "exit"; code: number }>
  | Readonly<{ type: "error"; message: string }>;

function parseIntent(argv: readonly string[], context: TeamCliContext): ParseResult {
  let intent: TeamCliIntent | undefined;
  const program = new Command()
    .name("acp-teams")
    .description("Run and coordinate a local team of ACP agents.")
    .version("0.1.0")
    .option("--state <path>", "team SQLite state path", context.env.ACP_TEAM_STATE)
    .option("--team <id>", "team id", context.env.ACP_TEAM_ID)
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: value => context.stdout.write(value),
      writeErr: value => context.stderr.write(value),
    });

  program.command("run")
    .description("start a new ACP Agent Team")
    .argument("<goal>", "team goal")
    .addOption(new Option("--agent <name>", "built-in ACP agent name").default("trae"))
    .option("--command <shell>", "explicit ACP agent shell command")
    .option("--model <model>", "provider model override")
    .option("--cwd <path>", "shared working directory", context.cwd)
    .option("--name <name>", "team name", "agent-team")
    .option("--lead-name <name>", "lead member name", "lead")
    .option("--max-teammates <count>", "maximum non-lead members", positiveInteger, 3)
    .option("--max-turns <count>", "team-wide ACP turn budget", positiveInteger, 24)
    .option("--inactivity-ms <ms>", "per-turn inactivity timeout", positiveInteger, 300_000)
    .option("--web", "start a read-only local Web observer", false)
    .action((goal: string, options: RunOptions, command: Command) => {
      if (options.command !== undefined && command.getOptionValueSource("agent") === "cli") {
        throw new CommanderError(2, "agent-conflict", "Choose either --agent or --command, not both.");
      }
      intent = {
        type: "run",
        goal,
        cwd: options.cwd,
        name: options.name,
        leadName: options.leadName,
        agent: options.command === undefined
          ? { kind: "named", name: options.agent }
          : { kind: "command", command: options.command },
        ...(options.model === undefined ? {} : { model: options.model }),
        maxTeammates: options.maxTeammates,
        maxTurns: options.maxTurns,
        inactivityMs: options.inactivityMs,
        web: options.web,
        ...(program.opts<{ state?: string }>().state === undefined
          ? {}
          : { statePath: program.opts<{ state: string }>().state }),
      };
    });

  const task = program.command("task").description("manage the shared task board");
  task.command("create")
    .requiredOption("--subject <text>")
    .option("--description <text>", "task details", "")
    .option("--depends-on <task...>", "task ids that must complete first")
    .action((options: { subject: string; description: string; dependsOn?: string[] }) => {
      intent = withTeamContext(program, context, {
        type: "task.create",
        subject: options.subject,
        description: options.description,
        dependencies: options.dependsOn ?? [],
      });
    });
  task.command("list").action(() => {
    intent = withTeamContext(program, context, { type: "task.list" });
  });
  task.command("claim").argument("<task-id>").action((taskId: string) => {
    intent = withTeamContext(program, context, { type: "task.claim", taskId });
  });
  task.command("complete")
    .argument("<task-id>")
    .requiredOption("--summary <text>")
    .action((taskId: string, options: { summary: string }) => {
      intent = withTeamContext(program, context, { type: "task.complete", taskId, summary: options.summary });
    });

  const teammate = program.command("teammate").description("manage team members");
  teammate.command("spawn")
    .argument("<name>")
    .requiredOption("--task <task-id>")
    .requiredOption("--prompt <text>")
    .action((name: string, options: { task: string; prompt: string }) => {
      intent = withTeamContext(program, context, {
        type: "teammate.spawn",
        name,
        taskId: options.task,
        prompt: options.prompt,
      });
    });
  teammate.command("list").action(() => {
    intent = withTeamContext(program, context, { type: "teammate.list" });
  });
  teammate.command("stop").argument("<name>").action((name: string) => {
    intent = withTeamContext(program, context, { type: "teammate.stop", name });
  });

  const message = program.command("message").description("send durable team messages");
  message.command("send")
    .argument("<recipient>")
    .requiredOption("--body <text>")
    .action((recipient: string, options: { body: string }) => {
      intent = withTeamContext(program, context, { type: "message.send", recipient, body: options.body });
    });

  program.command("inbox").option("--limit <count>", "maximum messages", positiveInteger, 50)
    .action((options: { limit: number }) => {
      intent = withTeamContext(program, context, { type: "inbox", limit: options.limit });
    });
  program.command("status").action(() => {
    intent = withTeamContext(program, context, { type: "status" }, false);
  });
  program.command("wait")
    .description("wait until every shared task is completed")
    .option("--timeout-ms <ms>", "maximum wait", positiveInteger, 120_000)
    .action((options: { timeoutMs: number }) => {
      intent = withTeamContext(program, context, { type: "wait", timeoutMs: options.timeoutMs }, false);
    });
  program.command("trajectory")
    .option("--limit <count>", "maximum latest events", positiveInteger, 500)
    .action((options: { limit: number }) => {
      intent = withTeamContext(program, context, { type: "trajectory", limit: options.limit }, false);
    });
  program.command("complete").requiredOption("--summary <text>")
    .action((options: { summary: string }) => {
      intent = withTeamContext(program, context, { type: "team.complete", summary: options.summary });
    });

  try {
    program.parse(["node", "acp-teams", ...argv]);
  } catch (error) {
    if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.version"].includes(error.code)) {
      return { type: "exit", code: 0 };
    }
    return { type: "error", message: error instanceof Error ? error.message : String(error) };
  }
  return intent === undefined ? { type: "error", message: "A command is required. Run acp-teams --help." } : { type: "intent", intent };
}

function withTeamContext<T extends Omit<TeamCliIntent, "statePath" | "teamId" | "actorName">>(
  program: Command,
  context: TeamCliContext,
  value: T,
  requireActor = true,
): TeamCliIntent {
  const statePath = program.opts<{ state?: string }>().state;
  if (statePath === undefined) throw new CommanderError(2, "missing-state", "ACP_TEAM_STATE or --state is required.");
  const teamId = program.opts<{ team?: string }>().team;
  if (teamId === undefined) throw new CommanderError(2, "missing-team", "ACP_TEAM_ID or --team is required.");
  const actorName = context.env.ACP_TEAM_MEMBER;
  if (requireActor && actorName === undefined) {
    throw new CommanderError(2, "missing-actor", "ACP_TEAM_MEMBER is required for this command.");
  }
  return {
    ...value,
    statePath,
    teamId,
    ...(actorName === undefined ? {} : { actorName }),
  } as TeamCliIntent;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommanderError(2, "invalid-number", `'${value}' must be a positive integer.`);
  }
  return parsed;
}

type RunOptions = Readonly<{
  agent: string;
  command?: string;
  model?: string;
  cwd: string;
  name: string;
  leadName: string;
  maxTeammates: number;
  maxTurns: number;
  inactivityMs: number;
  web: boolean;
}>;
