mod agent_overrides;
mod catalog;

use acpus_core::{
    ApplyAgentOverridesResult, CompileOptions, DiagnosticSeverity, EVENT_NAMES, HookConfig,
    HookHandler, INJECTOR_NAMES, apply_agent_overrides, compile_workflow_path,
    is_empty_hook_config, lint_workflow, validate_hook_config_shape,
};
use acpus_runtime::{
    HookConfigLoader, RunStore, global_hook_config_path, project_hook_config_path,
};
use acpus_supervisor::{Supervisor, SupervisorMetadata};
use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, OpenOptions},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const EXIT_RUNTIME_ERROR: u8 = 20;
const EXIT_FORK_REJECTED: u8 = 21;
const EXIT_SUPERVISOR_ERROR: u8 = 40;
const EXIT_CLI_ERROR: u8 = 1;
const EXIT_DSL_STATIC_ERROR: u8 = 10;
const EXIT_USER_CANCEL: u8 = 2;

#[derive(Parser)]
#[command(
    name = "acpus",
    version,
    about = "Local durable workflow runner for ACP agents",
    long_about = "Run, inspect, and control durable local ACP workflow runs from the current workspace."
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    #[command(
        visible_alias = "wf",
        about = "Discover, inspect, lint, and run Workflow Specs"
    )]
    Workflows(WorkflowCommand),
    #[command(about = "List, inspect, clean, visualize, and control Workflow Runs")]
    Runs(RunCommand),
    #[command(about = "Inspect and validate Acpus runtime hook configuration")]
    Hooks(HookCommand),
    #[command(hide = true)]
    Supervisor(SupervisorCommand),
}

#[derive(Args)]
struct WorkflowCommand {
    #[command(subcommand)]
    command: WorkflowSubcommand,
}

#[derive(Subcommand)]
enum WorkflowSubcommand {
    #[command(about = "Validate a Workflow Spec")]
    Lint {
        #[arg(
            value_name = "refOrPath",
            help = "Workflow Catalog ref/name or workflow YAML spec path"
        )]
        target: String,
        #[arg(long, help = "Treat warnings as errors")]
        strict: bool,
        #[arg(long, help = "Write JSON output")]
        json: bool,
        #[arg(long, help = "Only write final output")]
        quiet: bool,
    },
    #[command(
        about = "Start a Workflow Run",
        long_about = "Start a Workflow Run through the workspace supervisor, then follow it until terminal status unless --background, --visualize, or --dry-run is used.",
        after_help = "Examples:\n  acpus workflows run project:build\n  acpus wf run ./workflow.yaml --input input.json\n  acpus workflows run project:deploy --agents agents.yaml --background\n  acpus workflows run ./workflow.yaml --dry-run --json"
    )]
    Run(RunWorkflow),
    #[command(about = "List catalog workflows")]
    List {
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(about = "Show catalog workflow details")]
    Show {
        #[arg(
            value_name = "refOrName",
            help = "Workflow Catalog ref or unique workflow name"
        )]
        target: String,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
}

#[derive(Args)]
struct RunWorkflow {
    #[arg(
        value_name = "refOrPath",
        help = "Workflow Catalog ref/name or workflow YAML spec path"
    )]
    target: String,
    #[arg(
        long,
        value_name = "value",
        help = "Inline JSON/YAML object or path to a .json/.yaml/.yml input object file"
    )]
    input: Option<String>,
    #[arg(
        long,
        value_name = "value",
        help = "Inline JSON/YAML object or path to a .json/.yaml/.yml Agent Overrides object file"
    )]
    agents: Option<String>,
    #[arg(
        long,
        value_name = "duration",
        help = "Follow-mode poll interval such as 2s, 1m, or 1000ms; default 10s, minimum 1s"
    )]
    poll: Option<String>,
    #[arg(long, help = "Compile to IR and print the schedule without execution")]
    dry_run: bool,
    #[arg(long, help = "Submit and return immediately without following the run")]
    background: bool,
    #[arg(long, help = "Submit and open the TUI visualizer")]
    visualize: bool,
    #[arg(long, help = "Submit without loading, freezing, or executing hooks")]
    skip_hooks: bool,
    #[arg(
        long,
        help = "Write JSONL observations in follow mode or one JSON object in background/dry-run mode"
    )]
    json: bool,
    #[arg(long, help = "Only write final output")]
    quiet: bool,
}

#[derive(Args)]
struct RunCommand {
    #[command(subcommand)]
    command: RunSubcommand,
}

#[derive(Subcommand)]
enum RunSubcommand {
    #[command(about = "List Workflow Runs")]
    List {
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(about = "Inspect a Workflow Run")]
    Show {
        #[arg(value_name = "runId", help = "Run ID to inspect")]
        run_id: String,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(about = "Pause an active Workflow Run")]
    Pause {
        #[arg(value_name = "runId", help = "Run ID to pause")]
        run_id: String,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(about = "Resume a paused Workflow Run")]
    Resume {
        #[arg(value_name = "runId", help = "Run ID to resume")]
        run_id: String,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(
        about = "Deliver an external decision payload to a Signal Node",
        long_about = "Deliver an external decision payload to a Signal Node that is currently awaiting input.",
        after_help = "Examples:\n  acpus runs signal run_01 --node approve --payload '{\"approved\":true}'\n  acpus runs signal run_01 --node approve --payload decision.yaml --json"
    )]
    Signal {
        #[arg(
            value_name = "runId",
            help = "Run ID containing the awaiting Signal Node"
        )]
        run_id: String,
        #[arg(
            long,
            value_name = "nodeKey",
            help = "Signal Node Key to deliver the payload to"
        )]
        node: String,
        #[arg(
            long,
            value_name = "value",
            help = "Inline JSON/YAML object or path to a .json/.yaml/.yml payload object file"
        )]
        payload: String,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(about = "Cancel a Workflow Run")]
    Cancel {
        #[arg(value_name = "runId", help = "Run ID to cancel")]
        run_id: String,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(about = "Retry a Run or specific Node")]
    Retry {
        #[arg(value_name = "runId", help = "Run ID to retry")]
        run_id: String,
        #[arg(
            long,
            value_name = "nodeKey",
            help = "Retry a specific failed executable Node Key instead of the whole run"
        )]
        node: Option<String>,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(about = "Replay a Run and verify deterministic interpretation")]
    Replay {
        #[arg(value_name = "runId", help = "Run ID to replay")]
        run_id: String,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(
        about = "Open or serve the run visualizer",
        long_about = "Open the terminal visualizer, or serve a read-only browser visualizer when --serve is provided.",
        after_help = "Examples:\n  acpus runs visualize\n  acpus runs visualize run_01\n  acpus runs visualize run_01 --serve\n  acpus runs visualize --serve 127.0.0.1:3000"
    )]
    Visualize {
        #[arg(
            value_name = "runId",
            help = "Run ID to observe; omit to pick from a list"
        )]
        run_id: Option<String>,
        #[arg(
            long,
            value_name = "listen",
            num_args = 0..=1,
            default_missing_value = "",
            help = "Serve a read-only browser visualizer, optionally on a port or host:port"
        )]
        serve: Option<String>,
    },
    #[command(
        about = "Fork a terminal Run from matching checkpoints",
        long_about = "Derive a new Run from a terminal source Run, inheriting matching checkpoints from the source.",
        after_help = "Examples:\n  acpus runs fork run_01 ./fixed.workflow.yaml\n  acpus runs fork run_01 project:fixed --from build --dry-run\n  acpus runs fork run_01 ./fixed.workflow.yaml --input input.yaml --agents agents.yaml --background"
    )]
    Fork(ForkRun),
    #[command(about = "Delete terminal Run directories")]
    Clean {
        #[arg(long, help = "Report deletions without removing Run directories")]
        dry_run: bool,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
}

#[derive(Args)]
struct ForkRun {
    #[arg(
        value_name = "sourceRunId",
        help = "Terminal source Run ID to fork from"
    )]
    source_run_id: String,
    #[arg(
        value_name = "refOrPath",
        help = "Workflow Catalog ref/name or repaired workflow YAML spec path"
    )]
    target: String,
    #[arg(
        long,
        value_name = "value",
        help = "Inline JSON/YAML object or path to a .json/.yaml/.yml input object file; defaults to source input"
    )]
    input: Option<String>,
    #[arg(
        long,
        value_name = "value",
        help = "Inline JSON/YAML object or path to a .json/.yaml/.yml Agent Overrides object file"
    )]
    agents: Option<String>,
    #[arg(
        long,
        value_name = "duration",
        help = "Follow-mode poll interval such as 2s, 1m, or 1000ms; default 10s, minimum 1s"
    )]
    poll: Option<String>,
    #[arg(
        long = "from",
        value_name = "nodeKey",
        help = "Force the Fork Origin to a specific top-level or composite Node Key"
    )]
    from_node: Option<String>,
    #[arg(long, help = "Compute the fork plan without creating a new Run")]
    dry_run: bool,
    #[arg(long, help = "Submit and return immediately without following the run")]
    background: bool,
    #[arg(long, help = "Submit and open the TUI visualizer")]
    visualize: bool,
    #[arg(long, help = "Write JSON output")]
    json: bool,
    #[arg(long, help = "Only write final output")]
    quiet: bool,
}

#[derive(Args)]
struct HookCommand {
    #[command(subcommand)]
    command: HookSubcommand,
}

#[derive(Subcommand)]
enum HookSubcommand {
    #[command(
        about = "Validate hook configuration",
        long_about = "Validate global and project hook configuration files without running hook handlers.",
        after_help = "Examples:\n  acpus hooks validate\n  acpus hooks validate --global\n  acpus hooks validate --project /path/to/workspace --json"
    )]
    Validate {
        #[arg(long = "global", help = "Validate only the global ~/.acpus/hooks.yaml")]
        global_only: bool,
        #[arg(
            long,
            value_name = "path",
            help = "Validate the project hooks.yaml under the given workspace path"
        )]
        project: Option<PathBuf>,
        #[arg(long, help = "Write JSON output")]
        json: bool,
    },
    #[command(about = "List hook configuration")]
    List {
        #[arg(long, help = "Write JSON output")]
        json: bool,
        #[arg(long, help = "Show each handler's source layer")]
        source: bool,
    },
    #[command(name = "path")]
    #[command(about = "Print hook configuration paths")]
    Paths {
        #[arg(long = "global", help = "Print only the global hook path")]
        global_only: bool,
    },
}

#[derive(Args)]
struct SupervisorCommand {
    #[arg(long, default_value = "127.0.0.1:0")]
    listen: SocketAddr,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run_cli().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let (code, as_json, message) = classify_cli_error(&error);
            if let Some(message) = message {
                print_cli_error(&message, as_json);
            }
            ExitCode::from(code)
        }
    }
}

async fn run_cli() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Workflows(command) => workflows(command).await,
        Commands::Runs(command) => runs(command).await,
        Commands::Hooks(command) => hooks(command).await,
        Commands::Supervisor(command) => supervisor(command).await,
    }
}

async fn workflows(command: WorkflowCommand) -> anyhow::Result<()> {
    match command.command {
        WorkflowSubcommand::Lint {
            target,
            strict,
            json: as_json,
            quiet,
        } => {
            let target = catalog::resolve_lint_target(&target, &std::env::current_dir()?)?;
            let source = fs::read_to_string(&target.path)
                .with_context(|| format!("failed to read {}", target.path.display()))?;
            let result = lint_workflow(
                &source,
                CompileOptions {
                    source_path: Some(target.source_path()),
                    strict,
                    ..Default::default()
                },
            );
            if !quiet {
                if as_json {
                    println!(
                        "{}",
                        serde_json::to_string(&json!({
                            "ok": result.ok,
                            "diagnostics": result.diagnostics
                        }))?
                    );
                } else {
                    for d in &result.diagnostics {
                        eprintln!(
                            "{} {} {}: {}",
                            diagnostic_severity(&d.severity),
                            d.code,
                            d.path,
                            d.message
                        );
                    }
                    if result.ok {
                        println!("acpus lint: ok");
                    }
                }
            }
            if result.ok {
                Ok(())
            } else {
                Err(cli_exit(EXIT_DSL_STATIC_ERROR))
            }
        }
        WorkflowSubcommand::Run(args) => run_workflow(args).await,
        WorkflowSubcommand::List { json: as_json } => {
            let workspace = std::env::current_dir()?;
            let entries = catalog::list_workflow_catalog(&workspace);
            if as_json {
                println!("{}", machine_json(&entries)?);
            } else {
                println!("{}", format_workflow_list(&entries, &workspace));
            }
            Ok(())
        }
        WorkflowSubcommand::Show {
            target,
            json: as_json,
        } => {
            let target = catalog::find_workflow_catalog_entry(&target, &std::env::current_dir()?)?;
            if as_json {
                println!("{}", machine_json(&target)?);
                return Ok(());
            }
            print_workflow_details(&target);
            Ok(())
        }
    }
}

async fn run_workflow(args: RunWorkflow) -> anyhow::Result<()> {
    if let Some(message) =
        reject_conflicting_submission_options(args.background, args.visualize, args.json)
    {
        return Err(cli_failure(EXIT_CLI_ERROR, args.json, message));
    }
    let target = catalog::resolve_workflow_target(&args.target, &std::env::current_dir()?)
        .map_err(|error| workflow_lookup_error(error, args.json))?;
    let result = compile_workflow_path(
        &target.path,
        CompileOptions {
            source_path: Some(target.source_path()),
            strict: true,
            ..Default::default()
        },
    );
    if !result.ok {
        if args.json {
            println!("{}", machine_json(&result)?);
        } else {
            for d in result.diagnostics {
                eprintln!("{} {}: {}", d.path, d.code, d.message);
            }
        }
        return Err(cli_exit(EXIT_DSL_STATIC_ERROR));
    }
    let mut ir = result.ir.context("compiler did not return IR")?;
    let agent_metadata = apply_cli_agent_overrides(&mut ir, args.agents.as_deref(), None)?;
    let has_input = args.input.is_some();
    let input = match args.input.as_deref() {
        Some(raw) => parse_object_arg(raw, "--input")?,
        None => json!({}),
    };
    if args.dry_run {
        if has_input {
            ir.runtime_input = Some(input);
        }
        let output = workflow_dry_run_output(
            &ir,
            result.schedule.as_ref(),
            &result.diagnostics,
            &agent_metadata,
            args.agents.is_some(),
        );
        if args.json {
            println!("{}", machine_json(&output)?);
        } else if !args.quiet {
            println!("{}", serde_json::to_string_pretty(&output["schedule"])?);
        }
        print_submission_warnings(&agent_metadata.warnings, args.json, args.quiet);
        return Ok(());
    }
    let poll = foreground_poll_interval(args.background, args.visualize, args.poll.as_deref())?;
    let workspace = std::env::current_dir()?;
    let client = RunSupervisorClient::ensure(&workspace)
        .await?
        .with_json_errors(args.json);
    let run: acpus_runtime::RunState = client
        .post_json(
            "/runs",
            &json!({
                "ir": ir,
                "input": input,
                "workflowRef": target.ref_,
                "agentOverrides": agent_metadata.agent_overrides,
                "submissionWarnings": agent_metadata.warnings,
                "skipHooks": args.skip_hooks
            }),
        )
        .await?;
    if args.background {
        print_submission_warnings(&run.submission_warnings, args.json, args.quiet);
        print_json_or_human_quiet(
            args.json,
            args.quiet,
            &run,
            &format_workflow_background_run(&run),
        )?;
        return Ok(());
    }
    print_submission_warnings(&run.submission_warnings, args.json, args.quiet);
    if args.visualize {
        launch_visualizer(&client, Some(&run.run_id), None).await?;
        return Ok(());
    }
    follow_run(
        &client,
        &run.run_id,
        args.json,
        poll.context("foreground poll interval was not parsed")?,
    )
    .await
}

fn workflow_dry_run_output(
    ir: &acpus_core::AcpusIr,
    schedule: Option<&acpus_core::ScheduleSummary>,
    diagnostics: &[acpus_core::Diagnostic],
    agent_metadata: &ApplyAgentOverridesResult,
    include_agent_metadata: bool,
) -> Value {
    let mut output = serde_json::Map::from_iter([
        ("ok".to_string(), json!(true)),
        ("diagnostics".to_string(), json!(diagnostics)),
        ("ir".to_string(), json!(ir)),
        ("schedule".to_string(), json!(schedule)),
    ]);
    if include_agent_metadata {
        output.insert(
            "agentOverrides".to_string(),
            json!(agent_metadata.agent_overrides),
        );
        output.insert(
            "submissionWarnings".to_string(),
            json!(agent_metadata.warnings),
        );
    }
    Value::Object(output)
}

async fn runs(command: RunCommand) -> anyhow::Result<()> {
    let workspace = std::env::current_dir()?;
    let command = command.command;
    validate_run_command_before_supervisor(&command)?;
    match command {
        RunSubcommand::Signal {
            run_id,
            node,
            payload,
            json,
        } => {
            let payload = parse_signal_payload(&payload, json)?;
            let client = ensure_run_client(&workspace, json)
                .await?
                .with_json_errors(json);
            let node_state: acpus_runtime::NodeExecutionState = client
                .post_json_query(
                    &format!("/runs/{run_id}/signal"),
                    &[("key", node.clone())],
                    &payload,
                )
                .await?;
            print_json_or_human(
                json,
                &node_state,
                &format_node_action_result(&node, "signaled", node_state.state),
            )?;
            return Ok(());
        }
        RunSubcommand::Fork(args) => return fork_run(args).await,
        command => {
            let client = ensure_run_client(&workspace, run_command_json(&command)).await?;
            run_with_client(command, client).await?;
        }
    }
    Ok(())
}

async fn run_with_client(
    command: RunSubcommand,
    client: RunSupervisorClient,
) -> anyhow::Result<()> {
    match command {
        RunSubcommand::List { json: as_json } => {
            let client = client.with_json_errors(as_json);
            let runs: Vec<acpus_runtime::RunSummary> = client.get("/runs").await?;
            if as_json {
                println!("{}", machine_json(&runs)?);
            } else if runs.is_empty() {
                println!("No runs found.");
            } else {
                for run in runs {
                    println!("{}", format_run_list_line(&run));
                }
            }
        }
        RunSubcommand::Show {
            run_id,
            json: as_json,
        } => {
            let client = client.with_json_errors(as_json);
            let run: acpus_runtime::RunState = client.get(&format!("/runs/{run_id}")).await?;
            if as_json {
                println!("{}", serde_json::to_string(&run_show_json(&run)?)?);
            } else {
                let ir = if run.nodes.iter().any(|node| {
                    node.kind == acpus_core::IrNodeKind::RunSignal
                        && node.state == acpus_runtime::NodeState::Awaiting
                }) {
                    client
                        .get::<acpus_core::AcpusIr>(&format!("/runs/{run_id}/ir"))
                        .await
                        .ok()
                } else {
                    None
                };
                let signal_nodes = ir.as_ref().map(index_ir_nodes_by_path);
                println!("{}", format_run_show_header(&run));
                if let Some(error) = run.error {
                    println!("  Error: {error}");
                }
                for node in run
                    .nodes
                    .iter()
                    .filter(|node| should_show_node(node, &run.nodes))
                {
                    for line in format_node_lines(node) {
                        println!("{line}");
                    }
                    if node.kind == acpus_core::IrNodeKind::RunSignal
                        && node.state == acpus_runtime::NodeState::Awaiting
                    {
                        for line in format_awaiting_signal(
                            &run.run_id,
                            node,
                            signal_nodes.as_ref().and_then(|nodes| {
                                nodes.get(&acpus_runtime::static_node_path_from_key(&node.node_key))
                            }),
                        ) {
                            println!("{line}");
                        }
                    }
                }
                if run.status == acpus_runtime::RunStatus::Completed {
                    print_workflow_output(run.output.as_ref())?;
                }
            }
        }
        RunSubcommand::Pause { run_id, json } => {
            let client = client.with_json_errors(json);
            let run: acpus_runtime::RunState =
                client.post_empty(&format!("/runs/{run_id}/pause")).await?;
            print_json_or_human(
                json,
                &run,
                &format_run_control_result(&run_id, "pause", run.status),
            )?;
        }
        RunSubcommand::Resume { run_id, json } => {
            let client = client.with_json_errors(json);
            let run: acpus_runtime::RunState =
                client.post_empty(&format!("/runs/{run_id}/resume")).await?;
            print_json_or_human(
                json,
                &run,
                &format_run_control_result(&run_id, "resume", run.status),
            )?;
        }
        RunSubcommand::Cancel { run_id, json } => {
            let client = client.with_json_errors(json);
            let run: acpus_runtime::RunState =
                client.post_empty(&format!("/runs/{run_id}/cancel")).await?;
            print_json_or_human(
                json,
                &run,
                &format_run_control_result(&run_id, "cancel", run.status),
            )?;
        }
        RunSubcommand::Retry { run_id, node, json } => {
            let client = client.with_json_errors(json);
            if let Some(node) = node {
                let state: acpus_runtime::NodeExecutionState = client
                    .post_empty_query(&format!("/runs/{run_id}/retry"), &[("key", node.clone())])
                    .await?;
                print_json_or_human(
                    json,
                    &state,
                    &format_node_action_result(&node, "retried", state.state),
                )?;
                return Ok(());
            }
            let run: acpus_runtime::RunState =
                client.post_empty(&format!("/runs/{run_id}/retry")).await?;
            print_json_or_human(json, &run, &format_run_retry_result(&run_id, run.status))?;
        }
        RunSubcommand::Replay { run_id, json } => {
            let client = client.with_json_errors(json);
            let result: acpus_runtime::ReplayResult =
                client.post_empty(&format!("/runs/{run_id}/replay")).await?;
            if json {
                println!("{}", machine_json(&result)?);
            } else if result.ok {
                println!("Replay OK: {run_id} reproduced deterministically.");
            } else {
                println!(
                    "Replay MISMATCH: {run_id} ({} discrepancies)",
                    result.mismatches.len()
                );
                for mismatch in result.mismatches.iter().take(10) {
                    println!(
                        "  {} [{}] expected={} actual={}",
                        mismatch.node_key,
                        replay_mismatch_kind_text(&mismatch.kind),
                        mismatch.expected.map(status_text_node).unwrap_or("-"),
                        mismatch.actual.map(status_text_node).unwrap_or("-")
                    );
                }
            }
            if !result.ok {
                return Err(cli_exit(EXIT_RUNTIME_ERROR));
            }
        }
        RunSubcommand::Visualize { run_id, serve } => {
            launch_visualizer(&client, run_id.as_deref(), serve.as_deref()).await?;
        }
        RunSubcommand::Clean {
            dry_run,
            json: as_json,
        } => {
            let client = client.with_json_errors(as_json);
            let result: acpus_runtime::RunCleanResult = client
                .post_json("/runs/clean", &json!({ "dryRun": dry_run }))
                .await?;
            if as_json {
                println!("{}", machine_json(&result)?);
            } else {
                print_clean_result(&result);
            }
        }
        RunSubcommand::Signal { .. } | RunSubcommand::Fork(_) => {
            bail!("run command was dispatched to the wrong handler")
        }
    }
    Ok(())
}

fn parse_signal_payload(raw: &str, as_json: bool) -> anyhow::Result<Value> {
    parse_object_arg(raw, "--payload")
        .map_err(|error| cli_failure(EXIT_RUNTIME_ERROR, as_json, error.to_string()))
}

async fn ensure_run_client(workspace: &Path, as_json: bool) -> anyhow::Result<RunSupervisorClient> {
    match RunSupervisorClient::ensure(workspace).await {
        Ok(client) => Ok(client),
        Err(error) => {
            let message = error.to_string();
            let code = if is_supervisor_connection_error(&message) {
                EXIT_SUPERVISOR_ERROR
            } else {
                EXIT_RUNTIME_ERROR
            };
            Err(cli_failure(code, as_json, message))
        }
    }
}

fn validate_run_command_before_supervisor(command: &RunSubcommand) -> anyhow::Result<()> {
    if let RunSubcommand::Visualize { serve, .. } = command {
        validate_visualizer_listen(serve.as_deref())
            .map_err(|error| cli_failure(EXIT_CLI_ERROR, false, error.to_string()))?;
    }
    Ok(())
}

fn run_command_json(command: &RunSubcommand) -> bool {
    match command {
        RunSubcommand::List { json }
        | RunSubcommand::Show { json, .. }
        | RunSubcommand::Pause { json, .. }
        | RunSubcommand::Resume { json, .. }
        | RunSubcommand::Signal { json, .. }
        | RunSubcommand::Cancel { json, .. }
        | RunSubcommand::Retry { json, .. }
        | RunSubcommand::Replay { json, .. }
        | RunSubcommand::Clean { json, .. } => *json,
        RunSubcommand::Fork(args) => args.json,
        RunSubcommand::Visualize { .. } => false,
    }
}

async fn hooks(command: HookCommand) -> anyhow::Result<()> {
    match command.command {
        HookSubcommand::Validate {
            global_only,
            project,
            json: as_json,
        } => {
            let include_global = project.is_none();
            let workspace = project.unwrap_or(std::env::current_dir()?);
            let mut diagnostics = Vec::new();
            let mut parse_error = None;
            let mut layers = Vec::new();
            if include_global {
                layers.push(("global", global_hook_config_path()));
            }
            if !global_only {
                layers.push(("project", project_hook_config_path(&workspace)));
            }
            for (source, path) in layers {
                if !path.exists() {
                    continue;
                }
                match read_hook_config_for_validation(&path) {
                    Ok(value) => validate_hook_layer(source, &value, &mut diagnostics),
                    Err(error) => {
                        parse_error = Some(error.to_string());
                        break;
                    }
                }
            }
            let ok = parse_error.is_none() && diagnostics.iter().all(|d| d.ok);
            let output = HookValidateOutput {
                ok,
                parse_error,
                diagnostics,
            };
            if as_json {
                println!("{}", serde_json::to_string_pretty(&output)?);
            } else if let Some(error) = &output.parse_error {
                eprintln!("Invalid hooks file: {error}");
            } else if output.diagnostics.is_empty() {
                println!("No hooks configured.");
            } else {
                for diagnostic in output.diagnostics {
                    let status = if diagnostic.ok { "ok" } else { "error" };
                    let index = diagnostic
                        .index
                        .map(|index| format!("#{index}"))
                        .unwrap_or_default();
                    let message = diagnostic
                        .message
                        .map(|message| format!(": {message}"))
                        .unwrap_or_default();
                    println!(
                        "[{status}] {} {}{}{}",
                        diagnostic.source, diagnostic.injector_or_event, index, message
                    );
                }
            }
            if ok {
                Ok(())
            } else {
                Err(cli_exit(EXIT_CLI_ERROR))
            }
        }
        HookSubcommand::List {
            json: as_json,
            source,
        } => {
            let loader = HookConfigLoader::new(std::env::current_dir()?);
            let loaded = loader.load()?;
            if as_json {
                println!("{}", serde_json::to_string_pretty(&loaded.merged)?);
                return Ok(());
            }
            if is_empty_hook_config(&loaded.merged) {
                println!("No hooks configured");
                return Ok(());
            }
            let global_counts = count_handlers(&loaded.global_layer.config);
            print_hook_group(
                "injectors:",
                INJECTOR_NAMES,
                &loaded.merged.injectors,
                &global_counts.injectors,
                source,
            );
            print_hook_group(
                "events:",
                EVENT_NAMES,
                &loaded.merged.events,
                &global_counts.events,
                source,
            );
            Ok(())
        }
        HookSubcommand::Paths { global_only } => {
            let global = global_hook_config_path();
            println!("{}", format_hook_path(&global));
            if !global_only {
                println!(
                    "{}",
                    format_hook_path(&project_hook_config_path(std::env::current_dir()?))
                );
            }
            Ok(())
        }
    }
}

#[derive(Serialize)]
struct HookDiagnostic {
    #[serde(rename = "injectorOrEvent")]
    injector_or_event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<usize>,
    source: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Serialize)]
struct HookValidateOutput {
    ok: bool,
    #[serde(rename = "parseError", skip_serializing_if = "Option::is_none")]
    parse_error: Option<String>,
    diagnostics: Vec<HookDiagnostic>,
}

struct HookCounts {
    injectors: BTreeMap<String, usize>,
    events: BTreeMap<String, usize>,
}

fn validate_hook_layer(source: &str, value: &Value, diagnostics: &mut Vec<HookDiagnostic>) {
    diagnostics.extend(
        configured_hook_handlers(value)
            .into_iter()
            .map(|mut diagnostic| {
                diagnostic.source = source.to_string();
                diagnostic
            }),
    );
    for issue in validate_hook_config_shape(value) {
        let name = issue
            .hook_name
            .clone()
            .or(issue.path.clone())
            .unwrap_or_else(|| "$".to_string());
        if let Some(existing) = issue.handler_index.and_then(|index| {
            diagnostics.iter_mut().find(|diagnostic| {
                diagnostic.source == source
                    && diagnostic.injector_or_event == name
                    && diagnostic.index == Some(index)
            })
        }) {
            existing.ok = false;
            existing.message = Some(match existing.message.take() {
                Some(message) => format!("{message}; {}", issue.message),
                None => issue.message,
            });
        } else {
            diagnostics.push(HookDiagnostic {
                injector_or_event: name,
                index: issue.handler_index,
                source: source.to_string(),
                ok: false,
                message: Some(issue.message),
            });
        }
    }
}

fn configured_hook_handlers(value: &Value) -> Vec<HookDiagnostic> {
    let mut out = Vec::new();
    for group in ["injectors", "events"] {
        let Some(map) = value.get(group).and_then(Value::as_object) else {
            continue;
        };
        for (key, handlers) in map {
            if let Some(handlers) = handlers.as_array() {
                out.extend(
                    handlers
                        .iter()
                        .enumerate()
                        .map(|(index, _)| HookDiagnostic {
                            injector_or_event: key.clone(),
                            index: Some(index),
                            source: String::new(),
                            ok: true,
                            message: None,
                        }),
                );
            }
        }
    }
    out
}

fn read_hook_config_for_validation(path: &PathBuf) -> anyhow::Result<Value> {
    let raw = fs::read_to_string(path)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        Ok(json!({}))
    } else {
        Ok(serde_yaml::from_str(trimmed)?)
    }
}

fn count_handlers(config: &HookConfig) -> HookCounts {
    HookCounts {
        injectors: INJECTOR_NAMES
            .iter()
            .map(|key| {
                (
                    (*key).to_string(),
                    config.injectors.get(*key).map(Vec::len).unwrap_or(0),
                )
            })
            .collect(),
        events: EVENT_NAMES
            .iter()
            .map(|key| {
                (
                    (*key).to_string(),
                    config.events.get(*key).map(Vec::len).unwrap_or(0),
                )
            })
            .collect(),
    }
}

fn print_hook_group(
    label: &str,
    keys: &[&str],
    group: &BTreeMap<String, Vec<HookHandler>>,
    global_counts: &BTreeMap<String, usize>,
    show_source: bool,
) {
    for line in hook_group_lines(label, keys, group, global_counts, show_source) {
        println!("{line}");
    }
}

fn hook_group_lines(
    label: &str,
    keys: &[&str],
    group: &BTreeMap<String, Vec<HookHandler>>,
    global_counts: &BTreeMap<String, usize>,
    show_source: bool,
) -> Vec<String> {
    let mut lines = Vec::new();
    for key in keys {
        let Some(handlers) = group.get(*key).filter(|handlers| !handlers.is_empty()) else {
            continue;
        };
        if lines.is_empty() {
            lines.push(label.to_string());
        }
        lines.push(format!("  {key}"));
        lines.extend(handlers.iter().enumerate().map(|(index, handler)| {
            let source = if show_source {
                if index < *global_counts.get(*key).unwrap_or(&0) {
                    " (global)"
                } else {
                    " (project)"
                }
            } else {
                ""
            };
            format!("    - {}{}", describe_hook_handler(handler), source)
        }));
    }
    lines
}

fn describe_hook_handler(handler: &HookHandler) -> String {
    match &handler.timeout {
        Some(timeout) => format!("command: {} ({timeout})", handler.command),
        None => format!("command: {}", handler.command),
    }
}

fn format_workflow_list(entries: &[catalog::WorkflowCatalogEntry], workspace: &Path) -> String {
    if entries.is_empty() {
        return "No workflows found.".to_string();
    }
    let mut lines =
        vec!["SCOPE    STATUS    REF                  NAME                 PATH".to_string()];
    lines.extend(entries.iter().map(|entry| {
        format!(
            "{} {} {} {} {}",
            pad(&entry.scope.to_string(), 8),
            pad(&entry.status.to_string(), 9),
            pad(entry.ref_.as_deref().unwrap_or("-"), 20),
            pad(entry.name.as_deref().unwrap_or("-"), 20),
            display_workflow_path(&entry.path, workspace)
        )
    }));
    lines.join("\n")
}

fn pad(value: &str, width: usize) -> String {
    if value.len() >= width {
        value.to_string()
    } else {
        format!("{value}{}", " ".repeat(width - value.len()))
    }
}

fn display_workflow_path(path: &Path, workspace: &Path) -> String {
    path.strip_prefix(workspace)
        .ok()
        .and_then(|relative| {
            (!relative.as_os_str().is_empty()).then(|| relative.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| path.display().to_string())
}

fn print_workflow_details(entry: &catalog::WorkflowCatalogEntry) {
    println!("{}", format_workflow_details(entry));
}

fn format_workflow_details(entry: &catalog::WorkflowCatalogEntry) -> String {
    let mut lines = vec![
        format!("Workflow: {}", entry.name.as_deref().unwrap_or("-")),
        format!("Ref: {}", entry.ref_.as_deref().unwrap_or("-")),
        format!("Scope: {}", entry.scope),
        format!("Status: {}", entry.status),
        format!("Path: {}", entry.path.display()),
    ];
    if let Some(description) = &entry.description {
        lines.push(format!("Description: {description}"));
    }
    if !entry.input_keys.is_empty() {
        lines.push(format!("Inputs: {}", entry.input_keys.join(", ")));
    }
    if !entry.diagnostics.is_empty() {
        lines.push(String::new());
        lines.push("Diagnostics:".to_string());
        lines.extend(entry.diagnostics.iter().map(|diagnostic| {
            format!(
                "  {} {} {}: {}",
                diagnostic_severity(&diagnostic.severity),
                diagnostic.code,
                diagnostic.path,
                diagnostic.message
            )
        }));
    }
    lines.join("\n")
}

fn format_hook_path(path: &Path) -> String {
    format!(
        "{} {}",
        path.display(),
        if path.exists() {
            "(exists)"
        } else {
            "(missing)"
        }
    )
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ForkDryRunResponse {
    #[serde(rename = "dryRun")]
    dry_run: bool,
    plan: acpus_runtime::ForkPlan,
    #[serde(rename = "agentOverrides")]
    agent_overrides: acpus_core::AgentOverrides,
    #[serde(rename = "submissionWarnings")]
    submission_warnings: Vec<acpus_core::AgentOverrideWarning>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ForkRunResponse {
    run: acpus_runtime::RunState,
    plan: acpus_runtime::ForkPlan,
}

async fn fork_run(args: ForkRun) -> anyhow::Result<()> {
    if let Some(message) =
        reject_conflicting_submission_options(args.background, args.visualize, args.json)
    {
        return Err(cli_failure(EXIT_CLI_ERROR, args.json, message));
    }
    let workspace = std::env::current_dir()?;
    let target = catalog::resolve_workflow_target(&args.target, &workspace)
        .map_err(|error| workflow_lookup_error(error, args.json))?;
    let input = match args.input {
        Some(raw) => Some(parse_object_arg(&raw, "--input")?),
        None => None,
    };
    let agent_overrides =
        agent_overrides::parse_agent_overrides_input(args.agents.as_deref(), &workspace)?
            .unwrap_or_default();
    let client = RunSupervisorClient::ensure(&workspace)
        .await?
        .with_json_errors(args.json);
    let request = json!({
        "spec": fs::read_to_string(&target.path)?,
        "sourcePath": target.source_path(),
        "workflowRef": target.ref_,
        "input": input,
        "overrideOriginNodeKey": args.from_node,
        "dryRun": args.dry_run,
        "agentOverrides": agent_overrides
    });
    if args.dry_run {
        let response: ForkDryRunResponse = client
            .post_json(&format!("/runs/{}/fork", args.source_run_id), &request)
            .await?;
        print_json_or_human_quiet(
            args.json,
            args.quiet,
            &response,
            &format_fork_dry_run(&args.source_run_id, &response.plan),
        )?;
        print_submission_warnings(&response.submission_warnings, args.json, args.quiet);
        return Ok(());
    }
    let poll = foreground_poll_interval(args.background, args.visualize, args.poll.as_deref())?;
    let fork: ForkRunResponse = client
        .post_json(&format!("/runs/{}/fork", args.source_run_id), &request)
        .await?;
    if args.background {
        print_submission_warnings(&fork.run.submission_warnings, args.json, args.quiet);
        print_json_or_human_quiet(
            args.json,
            args.quiet,
            &fork,
            &format_fork_background_run(&args.source_run_id, &fork),
        )?;
        return Ok(());
    }
    print_submission_warnings(&fork.run.submission_warnings, args.json, args.quiet);
    if args.visualize {
        launch_visualizer(&client, Some(&fork.run.run_id), None).await?;
        return Ok(());
    }
    follow_run(
        &client,
        &fork.run.run_id,
        args.json,
        poll.context("foreground poll interval was not parsed")?,
    )
    .await
}

async fn supervisor(command: SupervisorCommand) -> anyhow::Result<()> {
    Supervisor::new(RunStore::new(std::env::current_dir()?))
        .serve(command.listen)
        .await
}

async fn launch_visualizer(
    client: &RunSupervisorClient,
    run_id: Option<&str>,
    serve: Option<&str>,
) -> anyhow::Result<()> {
    let modules = resolve_tui_modules();
    let mut command = Command::new("node");
    command
        .arg("--input-type=module")
        .arg("-e")
        .arg(if serve.is_some() {
            SERVE_TUI_SCRIPT
        } else {
            RUN_TUI_SCRIPT
        })
        .env("ACPUS_TUI_ENDPOINT", &client.endpoint)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(run_id) = run_id {
        command.env("ACPUS_TUI_RUN_ID", run_id);
    }
    if let Some(listen) = serve {
        command.env("ACPUS_TUI_LISTEN", listen);
    }
    if let Some(module) = modules.run {
        command.env("ACPUS_TUI_MODULE", module);
    }
    if let Some(module) = modules.serve {
        command.env("ACPUS_TUI_SERVE_MODULE", module);
    }
    let status = command.status().context(
        "failed to start Node visualizer; install Node.js and @acpus/tui or set ACPUS_TUI_MODULE",
    )?;
    anyhow::ensure!(status.success(), "visualizer exited with {status}");
    Ok(())
}

fn validate_visualizer_listen(value: Option<&str>) -> anyhow::Result<()> {
    let Some(raw) = value.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(());
    };
    if raw.chars().all(|c| c.is_ascii_digit()) {
        parse_visualizer_port(raw, raw)?;
        return Ok(());
    }
    let Some((host, port)) = raw.rsplit_once(':') else {
        anyhow::bail!(
            "Invalid listen value '{raw}'.\nHint: use '--serve <port>' or '--serve <host:port>'; if '{raw}' is a Run ID, put it before --serve."
        );
    };
    anyhow::ensure!(
        !host.is_empty() && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()),
        "Invalid listen value '{raw}'.\nHint: use '--serve <port>' or '--serve <host:port>'; if '{raw}' is a Run ID, put it before --serve."
    );
    parse_visualizer_port(port, raw)?;
    Ok(())
}

fn parse_visualizer_port(port: &str, source: &str) -> anyhow::Result<u16> {
    port.parse::<u16>().with_context(|| {
        format!("Invalid listen port in '{source}'. Port must be an integer from 0 to 65535.")
    })
}

const RUN_TUI_SCRIPT: &str = r#"
const moduleRef = process.env.ACPUS_TUI_MODULE || "@acpus/tui";
const { runTui } = await import(moduleRef);
await runTui({
  endpoint: process.env.ACPUS_TUI_ENDPOINT,
  runId: process.env.ACPUS_TUI_RUN_ID || undefined
});
"#;

const SERVE_TUI_SCRIPT: &str = r#"
const moduleRef = process.env.ACPUS_TUI_SERVE_MODULE || "@acpus/tui/serve";
const { serveTui } = await import(moduleRef);
const listenEnv = process.env.ACPUS_TUI_LISTEN;
await serveTui({
  endpoint: process.env.ACPUS_TUI_ENDPOINT,
  runId: process.env.ACPUS_TUI_RUN_ID || undefined,
  listen: listenEnv === undefined ? undefined : (listenEnv === "" ? true : listenEnv)
});
"#;

struct TuiModules {
    run: Option<String>,
    serve: Option<String>,
}

fn resolve_tui_modules() -> TuiModules {
    let run = std::env::var("ACPUS_TUI_MODULE")
        .ok()
        .or_else(|| find_tui_dist().map(|dist| file_url(&dist.join("index.js"))));
    let serve = std::env::var("ACPUS_TUI_SERVE_MODULE").ok().or_else(|| {
        find_tui_dist()
            .map(|dist| file_url(&dist.join("serve.js")))
            .or_else(|| run.as_ref().map(|_| "@acpus/tui/serve".to_string()))
    });
    TuiModules { run, serve }
}

fn find_tui_dist() -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.extend(cwd.ancestors().map(Path::to_path_buf));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        roots.extend(parent.ancestors().map(Path::to_path_buf));
    }
    roots.into_iter().find_map(|root| {
        [
            root.join("packages/tui/dist"),
            root.join("acpus/packages/tui/dist"),
        ]
        .into_iter()
        .find(|path| path.join("index.js").exists() && path.join("serve.js").exists())
    })
}

fn file_url(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    format!("file://{}", encode_file_url_path(&raw))
}

fn encode_file_url_path(path: &str) -> String {
    path.bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
                vec![byte as char]
            } else {
                format!("%{byte:02X}").chars().collect()
            }
        })
        .collect()
}

struct RunSupervisorClient {
    endpoint: String,
    http: reqwest::Client,
    json_errors: bool,
    client_id: String,
    client_kind: Option<&'static str>,
}

impl RunSupervisorClient {
    async fn ensure(workspace: &Path) -> anyhow::Result<Self> {
        let metadata = ensure_workspace_supervisor(workspace).await?;
        Ok(Self {
            endpoint: metadata.endpoint,
            http: reqwest::Client::new(),
            json_errors: false,
            client_id: new_client_id(),
            client_kind: None,
        })
    }

    fn with_json_errors(&self, json_errors: bool) -> Self {
        Self {
            endpoint: self.endpoint.clone(),
            http: self.http.clone(),
            json_errors,
            client_id: self.client_id.clone(),
            client_kind: self.client_kind,
        }
    }

    fn with_client_kind(&self, client_kind: &'static str) -> Self {
        Self {
            endpoint: self.endpoint.clone(),
            http: self.http.clone(),
            json_errors: self.json_errors,
            client_id: self.client_id.clone(),
            client_kind: Some(client_kind),
        }
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        decode_response(
            self.request(self.http.get(self.url(path))).send().await?,
            self.json_errors,
        )
        .await
    }

    async fn post_empty<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        decode_response(
            self.request(self.http.post(self.url(path))).send().await?,
            self.json_errors,
        )
        .await
    }

    async fn post_empty_query<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> anyhow::Result<T> {
        decode_response(
            self.request(self.http.post(self.url(path)))
                .query(query)
                .send()
                .await?,
            self.json_errors,
        )
        .await
    }

    async fn post_json<T: DeserializeOwned>(&self, path: &str, body: &Value) -> anyhow::Result<T> {
        decode_response(
            self.request(self.http.post(self.url(path)))
                .json(body)
                .send()
                .await?,
            self.json_errors,
        )
        .await
    }

    async fn post_json_query<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
        body: &Value,
    ) -> anyhow::Result<T> {
        decode_response(
            self.request(self.http.post(self.url(path)))
                .query(query)
                .json(body)
                .send()
                .await?,
            self.json_errors,
        )
        .await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint, path)
    }

    fn request(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let request = request.header("x-acpus-client-id", &self.client_id);
        if let Some(kind) = self.client_kind {
            request.header("x-acpus-client-kind", kind)
        } else {
            request
        }
    }
}

fn new_client_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("rust-cli-{}-{millis}", std::process::id())
}

async fn decode_response<T: DeserializeOwned>(
    response: reqwest::Response,
    as_json: bool,
) -> anyhow::Result<T> {
    let status = response.status();
    if status.is_success() {
        return Ok(response.json().await?);
    }
    let body = response.text().await.unwrap_or_default();
    let (code, message) = api_error_body(&body);
    Err(cli_failure(
        code,
        as_json,
        format!("supervisor request failed ({status}): {message}"),
    ))
}

fn api_error_body(body: &str) -> (u8, String) {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return (EXIT_RUNTIME_ERROR, body.to_string());
    };
    let code = if value.get("kind").and_then(Value::as_str) == Some("fork-rejected") {
        EXIT_FORK_REJECTED
    } else {
        EXIT_RUNTIME_ERROR
    };
    let message = value
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string());
    (code, message)
}

async fn ensure_workspace_supervisor(workspace: &Path) -> anyhow::Result<SupervisorMetadata> {
    let workspace = workspace.canonicalize()?;
    let store = RunStore::new(&workspace);
    let metadata_path = supervisor_metadata_path(&store);
    if let Some(metadata) = validate_supervisor_metadata(&metadata_path, &workspace).await {
        return Ok(metadata);
    }
    let _ = fs::remove_file(&metadata_path);

    let _lock = SupervisorLock::acquire(&store.state_dir)?;
    if let Some(metadata) = validate_supervisor_metadata(&metadata_path, &workspace).await {
        return Ok(metadata);
    }
    let _ = fs::remove_file(&metadata_path);
    spawn_supervisor(&workspace, &store.state_dir, &metadata_path).await
}

async fn validate_supervisor_metadata(path: &Path, workspace: &Path) -> Option<SupervisorMetadata> {
    let metadata = read_supervisor_metadata(path)?;
    if metadata.schema_version != 1
        || metadata.workspace.canonicalize().ok()? != workspace
        || !metadata.endpoint.starts_with("http://127.0.0.1:")
    {
        return None;
    }
    let health = reqwest::Client::new()
        .get(format!("{}/health", metadata.endpoint))
        .send()
        .await
        .ok()?;
    if !health.status().is_success() {
        return None;
    }
    let body = health.json::<Value>().await.ok()?;
    if body.get("ok").and_then(Value::as_bool) != Some(true)
        || body.get("pid").and_then(Value::as_u64) != Some(metadata.pid as u64)
        || body.get("endpoint").and_then(Value::as_str) != Some(metadata.endpoint.as_str())
    {
        return None;
    }
    Some(metadata)
}

fn read_supervisor_metadata(path: &Path) -> Option<SupervisorMetadata> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

async fn spawn_supervisor(
    workspace: &Path,
    state_dir: &Path,
    metadata_path: &Path,
) -> anyhow::Result<SupervisorMetadata> {
    fs::create_dir_all(state_dir)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(state_dir.join("supervisor.log"))?;
    let mut child = Command::new(std::env::current_exe()?)
        .arg("supervisor")
        .arg("--listen")
        .arg("127.0.0.1:0")
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .spawn()
        .context("failed to start workspace supervisor")?;

    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        if let Some(metadata) = validate_supervisor_metadata(metadata_path, workspace).await {
            return Ok(metadata);
        }
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("workspace supervisor exited before becoming healthy: {status}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill();
    anyhow::bail!("workspace supervisor failed to start within 15s")
}

fn supervisor_metadata_path(store: &RunStore) -> PathBuf {
    store.state_dir.join("supervisor.json")
}

struct SupervisorLock {
    path: PathBuf,
    _file: fs::File,
}

const SUPERVISOR_LOCK_STALE_AFTER: Duration = Duration::from_secs(20);
const SUPERVISOR_LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(15);
const SUPERVISOR_LOCK_POLL_INTERVAL: Duration = Duration::from_millis(50);

impl SupervisorLock {
    fn acquire(state_dir: &Path) -> anyhow::Result<Self> {
        Self::acquire_with(
            state_dir,
            SUPERVISOR_LOCK_STALE_AFTER,
            SUPERVISOR_LOCK_WAIT_TIMEOUT,
            SUPERVISOR_LOCK_POLL_INTERVAL,
        )
    }

    fn acquire_with(
        state_dir: &Path,
        stale_after: Duration,
        wait_timeout: Duration,
        poll_interval: Duration,
    ) -> anyhow::Result<Self> {
        fs::create_dir_all(state_dir)?;
        let path = state_dir.join("supervisor.lock");
        let start = Instant::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => return Ok(Self { path, _file: file }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if stale_lock(&path, stale_after) {
                        match fs::remove_file(&path) {
                            Ok(()) => continue,
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                continue;
                            }
                            Err(error) => return Err(error.into()),
                        }
                    }
                    if start.elapsed() >= wait_timeout {
                        anyhow::bail!("timed out waiting for workspace supervisor lock");
                    }
                    std::thread::sleep(poll_interval);
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

fn stale_lock(path: &Path, stale_after: Duration) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= stale_after)
}

impl Drop for SupervisorLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

async fn follow_run(
    client: &RunSupervisorClient,
    run_id: &str,
    as_json: bool,
    poll: std::time::Duration,
) -> anyhow::Result<()> {
    let client = client.with_client_kind("follow");
    let mut last_run_status = None;
    let mut last_nodes = HashMap::new();
    loop {
        let run: acpus_runtime::RunState = client.get(&format!("/runs/{run_id}")).await?;
        if last_run_status != Some(run.status) {
            if !is_follow_terminal(run.status) {
                print_follow_run_observation(&run, as_json)?;
            }
            last_run_status = Some(run.status);
        }

        for node in run
            .nodes
            .iter()
            .filter(|node| should_show_node(node, &run.nodes))
        {
            let activity = format_agent_activity(node.agent_telemetry.as_ref(), chrono::Utc::now());
            let current = (node.state, activity);
            let previous = last_nodes.insert(node.node_key.clone(), current.clone());
            if previous.as_ref() != Some(&current) {
                print_follow_node_observation(node, as_json)?;
            }
        }

        if is_follow_terminal(run.status) {
            print_follow_summary(&run, as_json)?;
            return match run.status {
                acpus_runtime::RunStatus::Completed => Ok(()),
                acpus_runtime::RunStatus::Paused | acpus_runtime::RunStatus::Cancelled => {
                    Err(cli_exit(EXIT_USER_CANCEL))
                }
                acpus_runtime::RunStatus::Failed => Err(cli_exit(EXIT_RUNTIME_ERROR)),
                acpus_runtime::RunStatus::Running => Ok(()),
            };
        }
        tokio::time::sleep(poll).await;
    }
}

fn print_follow_run_observation(
    run: &acpus_runtime::RunState,
    as_json: bool,
) -> anyhow::Result<()> {
    if as_json {
        println!("{}", serde_json::to_string(&follow_run_observation(run))?);
    } else {
        println!(
            "▶ Run {} {} {}",
            run.run_id,
            run.workflow_name,
            status_text(run.status)
        );
    }
    Ok(())
}

fn follow_run_observation(run: &acpus_runtime::RunState) -> Value {
    let mut event = serde_json::Map::from_iter([
        ("type".to_string(), json!("run")),
        ("runId".to_string(), json!(run.run_id)),
        ("status".to_string(), json!(run.status)),
        ("workflowName".to_string(), json!(run.workflow_name)),
        ("createdAt".to_string(), json!(run.created_at)),
    ]);
    if let Some(workflow_ref) = &run.workflow_ref {
        event.insert("workflowRef".to_string(), json!(workflow_ref));
    }
    Value::Object(event)
}

fn print_follow_node_observation(
    node: &acpus_runtime::NodeExecutionState,
    as_json: bool,
) -> anyhow::Result<()> {
    if as_json {
        println!("{}", serde_json::to_string(&follow_node_observation(node))?);
    } else {
        for line in format_node_lines(node) {
            println!("{line}");
        }
    }
    Ok(())
}

fn print_follow_summary(run: &acpus_runtime::RunState, as_json: bool) -> anyhow::Result<()> {
    if as_json {
        let mut event = json!({
            "type": "summary",
            "runId": run.run_id,
            "status": run.status,
            "runDuration": compute_run_duration_ms(run)
        });
        if run.status == acpus_runtime::RunStatus::Completed
            && let Some(output) = run.output.as_ref().filter(|output| output.is_object())
        {
            event["output"] = output.clone();
        }
        println!("{}", serde_json::to_string(&event)?);
    } else {
        println!("{}", format_follow_summary(run)?);
    }
    Ok(())
}

fn follow_node_observation(node: &acpus_runtime::NodeExecutionState) -> Value {
    let mut event = serde_json::Map::from_iter([
        ("type".to_string(), json!("node")),
        ("nodeKey".to_string(), json!(node.node_key)),
        ("state".to_string(), json!(node.state)),
        ("kind".to_string(), json!(node.kind)),
        ("attempt".to_string(), json!(node.attempt)),
    ]);
    if let Some(started_at) = node.started_at {
        event.insert("startedAt".to_string(), json!(started_at));
    }
    if let Some(completed_at) = node.completed_at {
        event.insert("completedAt".to_string(), json!(completed_at));
    }
    if let Some(error) = &node.error {
        event.insert("error".to_string(), json!(error));
    }
    if !node.artifact_refs.is_empty() {
        event.insert("artifactRefs".to_string(), json!(node.artifact_refs));
    }
    if node.state == acpus_runtime::NodeState::Completed
        && let Some(output) = node.output.as_ref().filter(|output| output.is_object())
    {
        event.insert("output".to_string(), output.clone());
    }
    if let Some(telemetry) = &node.agent_telemetry {
        event.insert("agentTelemetry".to_string(), json!(telemetry));
    }
    Value::Object(event)
}

#[cfg(test)]
fn validate_control_transition(
    current: acpus_runtime::RunStatus,
    target: acpus_runtime::RunStatus,
) -> anyhow::Result<()> {
    acpus_runtime::ensure_status(current, target)
}

fn parse_object_arg(raw: &str, label: &str) -> anyhow::Result<Value> {
    let path = PathBuf::from(raw);
    let value: Value = if path.exists() {
        anyhow::ensure!(
            !path.is_dir(),
            "{label} must be a JSON/YAML file or inline JSON/YAML object, not a directory.\nHint: pass a file such as input.json or an inline object such as '{{\"key\":\"value\"}}'."
        );
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let text = std::fs::read_to_string(&path)?;
        if matches!(extension.as_str(), "yaml" | "yml") {
            serde_yaml::from_str(&text)?
        } else {
            serde_json::from_str(&text)?
        }
    } else {
        anyhow::ensure!(
            !looks_like_object_path(raw),
            "{label} file not found: {raw}\nHint: check the path, or pass an inline JSON/YAML object instead."
        );
        parse_inline_object_value(raw).with_context(|| {
            format!(
                "{label} must be inline JSON/YAML or an existing .json/.yaml/.yml file.\nHint: inline values must resolve to an object, for example '{{\"approved\":true}}'."
            )
        })?
    };
    anyhow::ensure!(
        value.is_object(),
        "{label} must resolve to an object.\nHint: wrap scalars or arrays in an object, for example '{{\"value\": ...}}'."
    );
    Ok(value)
}

fn parse_inline_object_value(raw: &str) -> anyhow::Result<Value> {
    serde_json::from_str(raw)
        .or_else(|_| serde_yaml::from_str(raw))
        .context("failed to parse inline JSON/YAML")
}

fn looks_like_object_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.starts_with('{')
        || trimmed.contains('\n')
        || trimmed
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect::<String>()
            .ends_with(':')
    {
        return false;
    }
    let extension = PathBuf::from(trimmed)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    trimmed.starts_with('.')
        || trimmed.starts_with('/')
        || trimmed.starts_with('~')
        || trimmed.contains('/')
        || matches!(extension.as_str(), "json" | "yaml" | "yml")
}

fn parse_poll_interval(raw: Option<&str>) -> anyhow::Result<std::time::Duration> {
    let ms = match raw {
        Some(value) => acpus_core::parse_duration_ms(value, Some(1_000)).with_context(|| {
            format!(
                "Invalid --poll value '{value}'.\nHint: use a duration like 2s, 1m, or 1000ms; minimum is 1s."
            )
        })?,
        None => 10_000,
    };
    Ok(std::time::Duration::from_millis(ms))
}

fn foreground_poll_interval(
    background: bool,
    visualize: bool,
    raw: Option<&str>,
) -> anyhow::Result<Option<std::time::Duration>> {
    if background || visualize {
        Ok(None)
    } else {
        parse_poll_interval(raw).map(Some)
    }
}

fn reject_conflicting_submission_options(
    background: bool,
    visualize: bool,
    as_json: bool,
) -> Option<&'static str> {
    if background && visualize {
        Some(
            "--background and --visualize are mutually exclusive.\nHint: choose --background to detach, or --visualize to attach the TUI.",
        )
    } else if visualize && as_json {
        Some(
            "--visualize and --json are mutually exclusive.\nHint: use --json for machine-readable follow output, or --visualize for the TUI.",
        )
    } else {
        None
    }
}

fn workflow_lookup_error(error: anyhow::Error, as_json: bool) -> anyhow::Error {
    if as_json {
        return error;
    }
    let message = error.to_string();
    if message.contains("Workflow '")
        || message.contains("Workflow Spec path not found")
        || message.contains("ambiguous")
    {
        anyhow::anyhow!(
            "{message}\nHint: run `acpus workflows list` to see catalog refs, or pass a workflow path like ./workflow.yaml."
        )
    } else {
        error
    }
}

fn apply_cli_agent_overrides(
    ir: &mut acpus_core::AcpusIr,
    raw: Option<&str>,
    inherited: Option<&acpus_core::AgentOverrides>,
) -> anyhow::Result<ApplyAgentOverridesResult> {
    let current = agent_overrides::parse_agent_overrides_input(raw, &std::env::current_dir()?)?;
    apply_agent_overrides(ir, current.as_ref(), inherited)
}

fn print_submission_warnings(
    warnings: &[acpus_core::AgentOverrideWarning],
    json: bool,
    quiet: bool,
) {
    if json || quiet {
        return;
    }
    for warning in warnings {
        eprintln!("{}", format_submission_warning(warning));
    }
}

fn format_submission_warning(warning: &acpus_core::AgentOverrideWarning) -> String {
    format!(
        "WARNING {} {}: {}",
        warning.code, warning.agent, warning.message
    )
}

fn print_json_or_human<T: serde::Serialize>(
    as_json: bool,
    value: &T,
    human: &str,
) -> anyhow::Result<()> {
    print_json_or_human_quiet(as_json, false, value, human)
}

fn machine_json<T: serde::Serialize>(value: &T) -> anyhow::Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn print_json_or_human_quiet<T: serde::Serialize>(
    as_json: bool,
    quiet: bool,
    value: &T,
    human: &str,
) -> anyhow::Result<()> {
    if as_json {
        println!("{}", machine_json(value)?);
    } else if !quiet {
        println!("{human}");
    }
    Ok(())
}

#[derive(Debug)]
struct CliFailure {
    code: u8,
    as_json: bool,
    message: Option<String>,
}

impl std::fmt::Display for CliFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message.as_deref().unwrap_or("CLI exited"))
    }
}

impl std::error::Error for CliFailure {}

fn cli_failure(code: u8, as_json: bool, message: impl Into<String>) -> anyhow::Error {
    CliFailure {
        code,
        as_json,
        message: Some(message.into()),
    }
    .into()
}

fn cli_exit(code: u8) -> anyhow::Error {
    CliFailure {
        code,
        as_json: false,
        message: None,
    }
    .into()
}

fn classify_cli_error(error: &anyhow::Error) -> (u8, bool, Option<String>) {
    if let Some(failure) = error.downcast_ref::<CliFailure>() {
        return (failure.code, failure.as_json, failure.message.clone());
    }
    let message = error.to_string();
    if is_supervisor_connection_error(&message) {
        (EXIT_SUPERVISOR_ERROR, false, Some(message))
    } else {
        (EXIT_RUNTIME_ERROR, false, Some(message))
    }
}

fn print_cli_error(message: &str, as_json: bool) {
    if as_json {
        let body = json!({
            "ok": false,
            "diagnostics": [{
                "severity": "error",
                "code": "CLI_ERROR",
                "message": message,
                "path": "$"
            }]
        });
        match serde_json::to_string(&body) {
            Ok(body) => println!("{body}"),
            Err(_) => eprintln!("{message}"),
        }
    } else {
        eprintln!("{message}");
    }
}

fn is_supervisor_connection_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "econnrefused",
        "fetch failed",
        "connect",
        "supervisor",
        "enoent",
        "spawn",
        "timed out",
        "failed to start",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

fn diagnostic_severity(severity: &DiagnosticSeverity) -> &'static str {
    match severity {
        DiagnosticSeverity::Error => "ERROR",
        DiagnosticSeverity::Warning => "WARNING",
    }
}

fn print_clean_result(result: &acpus_runtime::RunCleanResult) {
    let verb = if result.dry_run {
        "Would delete"
    } else {
        "Deleted"
    };
    println!(
        "{verb} {} terminal run(s), {}.",
        result.deleted_count,
        format_bytes(result.bytes_reclaimed)
    );
    if result.skipped_count > 0 {
        println!("Skipped {} run(s).", result.skipped_count);
    }
}

fn print_workflow_output(output: Option<&Value>) -> anyhow::Result<()> {
    let Some(output) = output else {
        return Ok(());
    };
    let empty_object = output.as_object().is_some_and(|object| object.is_empty());
    if output.is_null() || empty_object {
        return Ok(());
    }
    println!("  Output:");
    for line in format_workflow_output(output)?.lines() {
        println!("{line}");
    }
    Ok(())
}

fn format_workflow_output(output: &Value) -> anyhow::Result<String> {
    let rendered = serde_yaml::to_string(output)?;
    let lines = rendered.trim_end().lines().collect::<Vec<_>>();
    Ok(truncate_workflow_output_lines(&lines)
        .into_iter()
        .map(|line| format!("    {line}"))
        .collect::<Vec<_>>()
        .join("\n"))
}

const MAX_WORKFLOW_OUTPUT_LINES: usize = 25;

fn truncate_workflow_output_lines(lines: &[&str]) -> Vec<String> {
    if lines.len() <= MAX_WORKFLOW_OUTPUT_LINES {
        return lines
            .iter()
            .map(|line| compact_yaml_sequence_indent(line).to_string())
            .collect();
    }
    let mut cut = MAX_WORKFLOW_OUTPUT_LINES;
    while cut > 0 && starts_with_whitespace(lines[cut - 1]) {
        cut -= 1;
    }
    if cut == 0 || cut == 1 && !starts_with_whitespace(lines[0]) {
        return vec![format!(
            "... ({} more lines, output too large to preview)",
            lines.len()
        )];
    }
    let remaining = lines.len() - cut;
    let mut out = lines[..cut]
        .iter()
        .map(|line| compact_yaml_sequence_indent(line).to_string())
        .collect::<Vec<_>>();
    out.push(format!("... ({remaining} more lines)"));
    out
}

fn starts_with_whitespace(line: &str) -> bool {
    line.chars().next().is_some_and(char::is_whitespace)
}

fn compact_yaml_sequence_indent(line: &str) -> &str {
    let trimmed = line.trim_start_matches(' ');
    let indent = line.len() - trimmed.len();
    if indent >= 2 && trimmed.starts_with("- ") {
        &line[2..]
    } else {
        line
    }
}

fn format_run_list_line(run: &acpus_runtime::RunSummary) -> String {
    let source = run
        .workflow_ref
        .as_deref()
        .or(run.workflow_source_path.as_deref())
        .unwrap_or("-");
    let lineage = run
        .lineage
        .as_ref()
        .map(|lineage| format!("  forked from {}", lineage.source_run_id))
        .unwrap_or_default();
    format!(
        "{}  {}  {}  {}  {}{}",
        run.run_id,
        run.workflow_name,
        status_text(run.status),
        run.updated_at.to_rfc3339(),
        source,
        lineage
    )
}

fn run_show_json(run: &acpus_runtime::RunState) -> serde_json::Result<Value> {
    let mut value = serde_json::to_value(run)?;
    if let Some(nodes) = value.get_mut("nodes").and_then(Value::as_array_mut) {
        for node in nodes {
            if let Some(node) = node.as_object_mut() {
                node.remove("renderedPrompt");
            }
        }
    }
    Ok(value)
}

fn replay_mismatch_kind_text(kind: &acpus_runtime::ReplayMismatchKind) -> &'static str {
    match kind {
        acpus_runtime::ReplayMismatchKind::State => "state",
        acpus_runtime::ReplayMismatchKind::MissingInReplay => "missing-in-replay",
        acpus_runtime::ReplayMismatchKind::UnexpectedInReplay => "unexpected-in-replay",
    }
}

fn format_run_control_result(
    run_id: &str,
    action: &str,
    status: acpus_runtime::RunStatus,
) -> String {
    format!(
        "Run {run_id} {} (status: {})",
        past_tense_action(action),
        status_text(status)
    )
}

fn format_run_retry_result(run_id: &str, status: acpus_runtime::RunStatus) -> String {
    format!("Run {run_id} retried (status: {})", status_text(status))
}

fn format_node_action_result(
    node_key: &str,
    action: &str,
    state: acpus_runtime::NodeState,
) -> String {
    format!(
        "Node {node_key} {action} (state: {})",
        status_text_node(state)
    )
}

fn past_tense_action(action: &str) -> String {
    match action {
        "pause" => "paused".to_string(),
        "resume" => "resumed".to_string(),
        "cancel" => "cancelled".to_string(),
        _ => action.to_string(),
    }
}

fn format_workflow_background_run(run: &acpus_runtime::RunState) -> String {
    let mut lines = vec![format!("Run {} started: {}", run.run_id, run.workflow_name)];
    if let Some(workflow_ref) = &run.workflow_ref {
        lines.push(format!("Workflow: {workflow_ref}"));
    }
    lines.push(format!("Status: {}", status_text(run.status)));
    lines.join("\n")
}

fn format_fork_dry_run(source_run_id: &str, plan: &acpus_runtime::ForkPlan) -> String {
    let mut lines = vec![
        format!("Fork plan for {source_run_id}:"),
        format!(
            "  Fork Origin: {} ({})",
            plan.fork_origin_node_key, plan.boundary_reason
        ),
        format!("  Inherited Nodes: {}", plan.inherited_node_keys.len()),
    ];
    lines.extend(
        plan.inherited_node_keys
            .iter()
            .map(|key| format!("    + {key}")),
    );
    lines.join("\n")
}

fn format_fork_background_run(source_run_id: &str, fork: &ForkRunResponse) -> String {
    [
        format!("Run {} forked from {source_run_id}", fork.run.run_id),
        format!("Fork Origin: {}", fork.plan.fork_origin_node_key),
        format!("Inherited: {} node(s)", fork.plan.inherited_node_keys.len()),
        format!("Status: {}", status_text(fork.run.status)),
    ]
    .join("\n")
}

fn format_run_show_header(run: &acpus_runtime::RunState) -> String {
    let mut header = format!(
        "Run {}  {}  {}  {}",
        run.run_id,
        run.workflow_name,
        status_text(run.status),
        format_duration_from_ms(compute_run_duration_ms(run))
    );
    if let Some(lineage) = &run.lineage {
        header.push_str(&format!(
            "  forked from {} (origin={}, inherited={})",
            lineage.source_run_id, lineage.fork_origin_node_key, lineage.inherited_node_count
        ));
    }
    header
}

fn format_artifact_summary(
    state: acpus_runtime::NodeState,
    artifact_count: usize,
) -> Option<String> {
    (state == acpus_runtime::NodeState::Failed && artifact_count > 0)
        .then(|| format!("Artifacts: {artifact_count} files"))
}

fn is_follow_terminal(status: acpus_runtime::RunStatus) -> bool {
    matches!(
        status,
        acpus_runtime::RunStatus::Completed
            | acpus_runtime::RunStatus::Failed
            | acpus_runtime::RunStatus::Paused
            | acpus_runtime::RunStatus::Cancelled
    )
}

fn compute_run_duration_ms(run: &acpus_runtime::RunState) -> i64 {
    let Some(started_at) = run.nodes.iter().filter_map(|node| node.started_at).min() else {
        return 0;
    };
    let completed_at = run
        .nodes
        .iter()
        .filter_map(|node| node.completed_at)
        .max()
        .unwrap_or(run.updated_at);
    (completed_at - started_at).num_milliseconds().max(0)
}

fn format_follow_summary(run: &acpus_runtime::RunState) -> anyhow::Result<String> {
    let mut summary = format!(
        "{} Run {} {} {} {}",
        run_status_glyph(run.status),
        run.run_id,
        run.workflow_name,
        status_text(run.status),
        format_duration_from_ms(compute_run_duration_ms(run))
    );
    if run.status == acpus_runtime::RunStatus::Completed
        && let Some(output) = run.output.as_ref()
    {
        let empty_object = output.as_object().is_some_and(|object| object.is_empty());
        if !output.is_null() && !empty_object {
            summary.push_str("\n\n  Output:\n");
            summary.push_str(&format_workflow_output(output)?);
        }
    }
    Ok(summary)
}

fn should_show_node(
    node: &acpus_runtime::NodeExecutionState,
    all_nodes: &[acpus_runtime::NodeExecutionState],
) -> bool {
    if !is_container_kind(&node.kind) {
        return true;
    }
    let prefix = format!("{}/", node.node_key);
    let child_has_same_error = node.error.as_ref().is_some_and(|error| {
        all_nodes.iter().any(|child| {
            child.node_key.starts_with(&prefix)
                && !is_container_kind(&child.kind)
                && child.error.as_ref() == Some(error)
        })
    });
    let has_unique_error = node.error.is_some() && !child_has_same_error;
    let is_actionable_state = !matches!(
        node.state,
        acpus_runtime::NodeState::Completed | acpus_runtime::NodeState::Failed
    );
    has_unique_error || is_actionable_state
}

fn is_container_kind(kind: &acpus_core::IrNodeKind) -> bool {
    matches!(
        kind,
        acpus_core::IrNodeKind::Pipeline
            | acpus_core::IrNodeKind::Parallel
            | acpus_core::IrNodeKind::Fanout
            | acpus_core::IrNodeKind::If
            | acpus_core::IrNodeKind::Switch
            | acpus_core::IrNodeKind::Loop
            | acpus_core::IrNodeKind::Guard
            | acpus_core::IrNodeKind::Subworkflow
    )
}

fn format_node_lines(node: &acpus_runtime::NodeExecutionState) -> Vec<String> {
    format_node_lines_at(node, chrono::Utc::now())
}

fn format_node_lines_at(
    node: &acpus_runtime::NodeExecutionState,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<String> {
    let mut lines = vec![format_node_line_at(node, now)];
    if let Some(error) = &node.error {
        lines.push(format!("    Error: {error}"));
    }
    if let Some(summary) = format_artifact_summary(node.state, node.artifact_refs.len()) {
        lines.push(format!("    {summary}"));
    }
    if node.kind == acpus_core::IrNodeKind::RunAgent
        && node.state == acpus_runtime::NodeState::Running
        && let Some(activity) = format_agent_activity(node.agent_telemetry.as_ref(), now)
    {
        lines.push(format!("    Activity: {activity}"));
    }
    lines
}

fn format_agent_activity(
    telemetry: Option<&acpus_runtime::AgentTelemetry>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    let telemetry = telemetry?;
    let attempt = telemetry
        .attempts
        .iter()
        .find(|attempt| attempt.attempt == telemetry.current_attempt)
        .or_else(|| telemetry.attempts.last())?;
    let mut parts = vec![
        format!(
            "updated={} ago",
            format_activity_age(now, &attempt.updated_at)
        ),
        format!("tool_calls={}", attempt.tools.total_tool_call_count),
    ];
    let recent = attempt
        .tools
        .recent_calls
        .iter()
        .take(3)
        .filter_map(format_tool_call_name)
        .collect::<Vec<_>>();
    if !recent.is_empty() {
        parts.push(format!("recent={}", recent.join(", ")));
    }
    if attempt.tools.dropped_tool_call_count > 0 {
        parts.push(format!("dropped={}", attempt.tools.dropped_tool_call_count));
    }
    if let Some(context) = &attempt.context
        && context.used > 0
    {
        parts.push(format!(
            "context={}/{}",
            format_activity_number(context.used),
            format_activity_number(context.size)
        ));
    }
    if let Some(tokens) = attempt
        .token_usage
        .as_ref()
        .and_then(|usage| usage.total_tokens)
    {
        parts.push(format!("tokens={}", format_activity_number(tokens)));
    }
    Some(parts.join("; "))
}

fn format_tool_call_name(tool: &acpus_runtime::AgentToolCallTelemetry) -> Option<String> {
    tool.title
        .as_deref()
        .or(tool.tool_name.as_deref())
        .or(tool.kind.as_deref())
        .or(Some(tool.tool_call_id.as_str()))
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|value| !value.is_empty())
}

fn format_activity_age(now: chrono::DateTime<chrono::Utc>, then: &str) -> String {
    let delta = chrono::DateTime::parse_from_rfc3339(then)
        .map(|then| now.signed_duration_since(then.with_timezone(&chrono::Utc)))
        .unwrap_or_default()
        .num_seconds()
        .max(0);
    if delta < 60 {
        return format!("{delta}s");
    }
    let minutes = delta / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 48 {
        return format!("{hours}h");
    }
    format!("{}d", hours / 24)
}

fn format_activity_number(value: u64) -> String {
    if value < 1000 {
        value.to_string()
    } else {
        format!("{}k", value / 1000)
    }
}

fn format_node_line_at(
    node: &acpus_runtime::NodeExecutionState,
    now: chrono::DateTime<chrono::Utc>,
) -> String {
    let mut parts = vec![
        node.node_key.clone(),
        format!("[{}]", compact_kind(&node.kind)),
    ];
    if node.state != acpus_runtime::NodeState::Completed {
        parts.push(status_text_node(node.state).to_string());
    }
    if let Some(duration) = format_node_duration(node, now) {
        parts.push(duration);
    }
    if node.attempt > 1 {
        parts.push(format!("attempt={}", node.attempt));
    }
    format!("  {} {}", state_glyph(node.state), parts.join("  "))
}

fn format_node_duration(
    node: &acpus_runtime::NodeExecutionState,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    let started_at = node.started_at?;
    let completed_at = node.completed_at.or_else(|| {
        matches!(
            node.state,
            acpus_runtime::NodeState::Running
                | acpus_runtime::NodeState::Awaiting
                | acpus_runtime::NodeState::Paused
        )
        .then_some(now)
    })?;
    Some(format_duration_from_ms(
        (completed_at - started_at).num_milliseconds(),
    ))
}

fn format_duration_from_ms(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    if seconds < 60 {
        return if seconds == 0 {
            "<1s".to_string()
        } else {
            format!("{seconds}s")
        };
    }
    let minutes = seconds / 60;
    let remaining_seconds = seconds % 60;
    if minutes < 60 {
        return if remaining_seconds == 0 {
            format!("{minutes}m")
        } else {
            format!("{minutes}m{remaining_seconds}s")
        };
    }
    let hours = minutes / 60;
    if hours < 48 {
        format!("{hours}h")
    } else {
        format!("{}d", hours / 24)
    }
}

fn state_glyph(state: acpus_runtime::NodeState) -> &'static str {
    match state {
        acpus_runtime::NodeState::Pending => "○",
        acpus_runtime::NodeState::Running => "⠋",
        acpus_runtime::NodeState::Awaiting => "⏳",
        acpus_runtime::NodeState::Completed => "✓",
        acpus_runtime::NodeState::Failed => "◆",
        acpus_runtime::NodeState::Paused => "⏸",
        acpus_runtime::NodeState::Cancelled => "✗",
    }
}

fn run_status_glyph(status: acpus_runtime::RunStatus) -> &'static str {
    match status {
        acpus_runtime::RunStatus::Running => "▶",
        acpus_runtime::RunStatus::Completed => "✓",
        acpus_runtime::RunStatus::Failed => "◆",
        acpus_runtime::RunStatus::Paused => "⏸",
        acpus_runtime::RunStatus::Cancelled => "✗",
    }
}

fn compact_kind(kind: &acpus_core::IrNodeKind) -> &'static str {
    match kind {
        acpus_core::IrNodeKind::RunAgent => "agent",
        acpus_core::IrNodeKind::RunProgram => "program",
        acpus_core::IrNodeKind::RunSignal => "signal",
        acpus_core::IrNodeKind::Pipeline => "pipeline",
        acpus_core::IrNodeKind::Parallel => "parallel",
        acpus_core::IrNodeKind::Fanout => "fanout",
        acpus_core::IrNodeKind::If => "if",
        acpus_core::IrNodeKind::Switch => "switch",
        acpus_core::IrNodeKind::Loop => "loop",
        acpus_core::IrNodeKind::Guard => "guard",
        acpus_core::IrNodeKind::Subworkflow => "subworkflow",
    }
}

fn index_ir_nodes_by_path(ir: &acpus_core::AcpusIr) -> HashMap<String, &acpus_core::IrNode> {
    fn walk<'a>(node: &'a acpus_core::IrNode, out: &mut HashMap<String, &'a acpus_core::IrNode>) {
        out.insert(node.node_path.join("/"), node);
        for child in &node.children {
            walk(child, out);
        }
        for branch in &node.branches {
            walk(&branch.child, out);
        }
    }
    let mut out = HashMap::new();
    walk(&ir.root, &mut out);
    out
}

fn format_awaiting_signal(
    run_id: &str,
    node: &acpus_runtime::NodeExecutionState,
    ir_node: Option<&&acpus_core::IrNode>,
) -> Vec<String> {
    let mut lines = Vec::new();
    let prompt = node.rendered_prompt.as_deref().or_else(|| {
        ir_node
            .and_then(|node| node.metadata.get("prompt"))
            .and_then(Value::as_str)
    });
    if let Some(prompt) = prompt {
        lines.push("    Prompt:".to_string());
        lines.extend(
            prompt
                .trim_end()
                .lines()
                .map(|line| format!("      {line}")),
        );
    }

    let schema = ir_node.and_then(|node| node.metadata.get("output"));
    if let Some(schema) = schema.and_then(Value::as_object) {
        let fields = describe_schema_fields(&Value::Object(schema.clone()));
        if fields.is_empty() {
            lines.push(
                "    Expected payload: {} (empty object; no properties declared)".to_string(),
            );
        } else {
            lines.push("    Expected payload:".to_string());
            lines.extend(fields.into_iter().map(|field| format!("      {field}")));
        }
    } else {
        lines.push("    Expected payload: any JSON object (no schema declared)".to_string());
    }
    lines.push(format!(
        "    Deliver: acpus runs signal {run_id} --node {} --payload '{{...}}'",
        node.node_key
    ));
    lines
}

fn describe_schema_fields(schema: &Value) -> Vec<String> {
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    properties
        .iter()
        .map(|(name, schema)| {
            let ty = schema
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("value");
            let requiredness = if required.contains(name.as_str()) {
                "required"
            } else {
                "optional"
            };
            format!("{name}: {ty} ({requiredness})")
        })
        .collect()
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1} KiB", bytes as f64 / 1024.0);
    }
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}

fn status_text(status: acpus_runtime::RunStatus) -> &'static str {
    match status {
        acpus_runtime::RunStatus::Running => "running",
        acpus_runtime::RunStatus::Completed => "completed",
        acpus_runtime::RunStatus::Failed => "failed",
        acpus_runtime::RunStatus::Paused => "paused",
        acpus_runtime::RunStatus::Cancelled => "cancelled",
    }
}

fn status_text_node(status: acpus_runtime::NodeState) -> &'static str {
    match status {
        acpus_runtime::NodeState::Pending => "pending",
        acpus_runtime::NodeState::Running => "running",
        acpus_runtime::NodeState::Awaiting => "awaiting",
        acpus_runtime::NodeState::Completed => "completed",
        acpus_runtime::NodeState::Failed => "failed",
        acpus_runtime::NodeState::Paused => "paused",
        acpus_runtime::NodeState::Cancelled => "cancelled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    fn cli_help(args: &[&str]) -> String {
        let mut argv = vec!["acpus"];
        argv.extend(args.iter().copied());
        argv.push("--help");
        let error = match Cli::try_parse_from(argv) {
            Ok(_) => panic!("expected help to stop parsing"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), ErrorKind::DisplayHelp);
        error.to_string()
    }

    fn assert_contains_all(text: &str, needles: &[&str]) {
        for needle in needles {
            assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
        }
    }

    #[test]
    fn root_help_is_user_facing_and_keeps_supervisor_hidden() {
        let help = cli_help(&[]);

        assert_contains_all(
            &help,
            &[
                "Run, inspect, and control durable local ACP workflow runs",
                "workflows",
                "wf",
                "runs",
                "hooks",
            ],
        );
        assert!(!help.contains("supervisor"));
    }

    #[test]
    fn workflow_help_describes_targets_inputs_and_examples() {
        let group_help = cli_help(&["workflows"]);
        assert_contains_all(&group_help, &["lint", "run", "list", "show"]);

        let run_help = cli_help(&["workflows", "run"]);
        assert_contains_all(
            &run_help,
            &[
                "<refOrPath>",
                "Workflow Catalog ref/name or workflow YAML spec path",
                "--input <value>",
                "Inline JSON/YAML object or path to a .json/.yaml/.yml input object file",
                "--agents <value>",
                "Agent Overrides object file",
                "--poll <duration>",
                "default 10s, minimum 1s",
                "--skip-hooks",
                "Examples:",
            ],
        );
        assert!(!run_help.contains("<TARGET>"));
    }

    #[test]
    fn runs_help_describes_complex_commands_and_examples() {
        let group_help = cli_help(&["runs"]);
        assert_contains_all(
            &group_help,
            &[
                "list",
                "show",
                "signal",
                "retry",
                "visualize",
                "fork",
                "clean",
            ],
        );

        let fork_help = cli_help(&["runs", "fork"]);
        assert_contains_all(
            &fork_help,
            &[
                "<sourceRunId>",
                "<refOrPath>",
                "--from <nodeKey>",
                "Fork Origin",
                "--input <value>",
                "--agents <value>",
                "--poll <duration>",
                "Examples:",
            ],
        );

        let signal_help = cli_help(&["runs", "signal"]);
        assert_contains_all(
            &signal_help,
            &[
                "<runId>",
                "--node <nodeKey>",
                "Signal Node Key",
                "--payload <value>",
                "Inline JSON/YAML object or path to a .json/.yaml/.yml payload object file",
                "Examples:",
            ],
        );

        let visualize_help = cli_help(&["runs", "visualize"]);
        assert_contains_all(
            &visualize_help,
            &[
                "[runId]",
                "--serve [<listen>]",
                "port or host:port",
                "Examples:",
            ],
        );
        assert!(!signal_help.contains("<RUN_ID>"));
    }

    #[test]
    fn hooks_help_describes_validation_sources_and_examples() {
        let help = cli_help(&["hooks", "validate"]);

        assert_contains_all(
            &help,
            &[
                "--global",
                "global ~/.acpus/hooks.yaml",
                "--project <path>",
                "workspace path",
                "--json",
                "Examples:",
            ],
        );
    }

    #[test]
    fn parse_object_arg_accepts_inline_json_object() {
        assert_eq!(
            parse_object_arg(r#"{"files":["a.rs"]}"#, "--input").unwrap(),
            json!({ "files": ["a.rs"] })
        );
    }

    #[test]
    fn hook_validate_json_omits_absent_parse_error() {
        let ok = serde_json::to_value(HookValidateOutput {
            ok: true,
            parse_error: None,
            diagnostics: Vec::new(),
        })
        .unwrap();

        assert_eq!(ok, json!({ "ok": true, "diagnostics": [] }));

        let invalid = serde_json::to_value(HookValidateOutput {
            ok: false,
            parse_error: Some("bad yaml".to_string()),
            diagnostics: Vec::new(),
        })
        .unwrap();

        assert_eq!(
            invalid,
            json!({ "ok": false, "parseError": "bad yaml", "diagnostics": [] })
        );
    }

    #[test]
    fn hook_group_lines_use_declared_hook_order() {
        let group = BTreeMap::from([
            (
                "afterRun".to_string(),
                vec![HookHandler {
                    command: "after.sh".to_string(),
                    ..HookHandler::default()
                }],
            ),
            (
                "beforeRun".to_string(),
                vec![HookHandler {
                    command: "before.sh".to_string(),
                    ..HookHandler::default()
                }],
            ),
        ]);
        let global_counts =
            BTreeMap::from([("beforeRun".to_string(), 1), ("afterRun".to_string(), 0)]);

        assert_eq!(
            hook_group_lines("events:", EVENT_NAMES, &group, &global_counts, true),
            vec![
                "events:",
                "  beforeRun",
                "    - command: before.sh (global)",
                "  afterRun",
                "    - command: after.sh (project)"
            ]
        );
    }

    #[test]
    fn parse_object_arg_accepts_inline_yaml_object_and_rejects_scalar() {
        assert_eq!(
            parse_object_arg("files:\n  - a.rs", "--input").unwrap(),
            json!({ "files": ["a.rs"] })
        );
        assert!(parse_object_arg("1", "--input").is_err());
    }

    #[test]
    fn parse_object_arg_accepts_yaml_file_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.yaml");
        fs::write(&path, "files:\n  - a.rs\n").unwrap();

        assert_eq!(
            parse_object_arg(path.to_str().unwrap(), "--input").unwrap(),
            json!({ "files": ["a.rs"] })
        );
    }

    #[test]
    fn parse_object_arg_rejects_file_array() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.json");
        fs::write(&path, r#"["a.rs"]"#).unwrap();

        assert!(parse_object_arg(path.to_str().unwrap(), "--input").is_err());
    }

    #[test]
    fn parse_object_arg_rejects_directory() {
        let dir = tempfile::tempdir().unwrap();

        assert!(parse_object_arg(dir.path().to_str().unwrap(), "--input").is_err());
    }

    #[test]
    fn parse_object_arg_accepts_json_file_without_json_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.txt");
        fs::write(&path, r#"{"files":["a.rs"]}"#).unwrap();

        assert_eq!(
            parse_object_arg(path.to_str().unwrap(), "--input").unwrap(),
            json!({ "files": ["a.rs"] })
        );
    }

    #[test]
    fn invalid_signal_payload_preserves_json_error_mode_before_supervisor() {
        let error = parse_signal_payload("not-json", true).unwrap_err();

        let (code, as_json, message) = classify_cli_error(&error);
        assert_eq!(code, EXIT_RUNTIME_ERROR);
        assert!(as_json);
        let message = message.unwrap();
        assert!(message.contains("--payload must resolve to an object"));
        assert!(message.contains("Hint:"));
    }

    #[tokio::test]
    async fn workflow_lint_success_returns_without_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workflow.yaml");
        fs::write(
            &path,
            "version: 1\nname: ok\nworkflow:\n  steps:\n    - id: ok\n      run: program\n      cmd: echo ok\n",
        )
        .unwrap();

        workflows(WorkflowCommand {
            command: WorkflowSubcommand::Lint {
                target: path.display().to_string(),
                strict: false,
                json: false,
                quiet: true,
            },
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn workflow_lint_failure_returns_static_error_code() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workflow.yaml");
        fs::write(
            &path,
            "version: 1\nname: bad\nworkflow:\n  steps:\n    - id: bad\n      run: nope\n",
        )
        .unwrap();

        let error = workflows(WorkflowCommand {
            command: WorkflowSubcommand::Lint {
                target: path.display().to_string(),
                strict: false,
                json: false,
                quiet: true,
            },
        })
        .await
        .unwrap_err();

        assert_eq!(
            classify_cli_error(&error),
            (EXIT_DSL_STATIC_ERROR, false, None)
        );
    }

    #[tokio::test]
    async fn workflow_run_static_failure_returns_static_error_code() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workflow.yaml");
        fs::write(
            &path,
            "version: 1\nname: bad\nworkflow:\n  steps:\n    - id: bad\n      run: nope\n",
        )
        .unwrap();

        let error = run_workflow(RunWorkflow {
            target: path.display().to_string(),
            input: None,
            agents: None,
            poll: None,
            dry_run: true,
            background: false,
            visualize: false,
            skip_hooks: false,
            json: false,
            quiet: true,
        })
        .await
        .unwrap_err();

        assert_eq!(
            classify_cli_error(&error),
            (EXIT_DSL_STATIC_ERROR, false, None)
        );
    }

    #[tokio::test]
    async fn workflow_run_dry_run_accepts_skip_hooks_without_supervisor() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workflow.yaml");
        fs::write(
            &path,
            "version: 1\nname: ok\nworkflow:\n  steps:\n    - id: ok\n      run: program\n      cmd: echo ok\n",
        )
        .unwrap();

        run_workflow(RunWorkflow {
            target: path.display().to_string(),
            input: None,
            agents: None,
            poll: None,
            dry_run: true,
            background: false,
            visualize: false,
            skip_hooks: true,
            json: false,
            quiet: true,
        })
        .await
        .unwrap();
    }

    #[test]
    fn parse_object_arg_rejects_missing_path_like_value() {
        assert!(parse_object_arg("missing.json", "--input").is_err());
        assert!(parse_object_arg("./missing", "--payload").is_err());
    }

    #[test]
    fn parse_poll_interval_matches_cli_contract() {
        assert_eq!(parse_poll_interval(None).unwrap(), Duration::from_secs(10));
        assert_eq!(
            parse_poll_interval(Some("2s")).unwrap(),
            Duration::from_secs(2)
        );
        assert_eq!(
            parse_poll_interval(Some("1m")).unwrap(),
            Duration::from_secs(60)
        );
        assert_eq!(
            parse_poll_interval(Some("1000ms")).unwrap(),
            Duration::from_secs(1)
        );
        let error = parse_poll_interval(Some("500ms")).unwrap_err();
        assert!(error.to_string().contains("Invalid --poll value '500ms'"));
        assert!(error.to_string().contains("minimum is 1s"));
    }

    #[test]
    fn foreground_poll_interval_only_validates_following_modes() {
        assert_eq!(
            foreground_poll_interval(false, false, Some("2s")).unwrap(),
            Some(Duration::from_secs(2))
        );
        assert!(
            foreground_poll_interval(false, false, Some("500ms"))
                .unwrap_err()
                .to_string()
                .contains("Hint:")
        );
        assert_eq!(
            foreground_poll_interval(true, false, Some("500ms")).unwrap(),
            None
        );
        assert_eq!(
            foreground_poll_interval(false, true, Some("500ms")).unwrap(),
            None
        );
    }

    #[test]
    fn format_workflow_output_renders_yaml_indented_under_header() {
        let output = format_workflow_output(&json!({
            "verdict": "pass",
            "counts": { "blocking": 0 },
            "tags": ["ready", "reviewed"]
        }))
        .unwrap();

        assert_eq!(
            output,
            "    counts:\n      blocking: 0\n    tags:\n    - ready\n    - reviewed\n    verdict: pass"
        );
    }

    #[test]
    fn format_workflow_output_truncates_large_output_at_key_boundary() {
        let output = Value::Object(
            (1..=30)
                .map(|index| {
                    (
                        format!("key_{index:02}"),
                        json!(format!("value_{index:02}")),
                    )
                })
                .collect(),
        );

        let rendered = format_workflow_output(&output).unwrap();

        assert!(rendered.contains("    ... (5 more lines)"));
        assert!(!rendered.contains("key_30"));
        let before_indicator = rendered
            .lines()
            .rfind(|line| line.starts_with("    key_") && !line.contains("..."))
            .unwrap();
        assert!(before_indicator.starts_with("    key_25: value_25"));
    }

    #[test]
    fn format_workflow_output_avoids_dangling_large_nested_key() {
        let output = json!({
            "big": {
                "items": (0..40).map(|index| format!("item_{index}")).collect::<Vec<_>>()
            },
            "verdict": "pass"
        });

        let rendered = format_workflow_output(&output).unwrap();

        assert!(rendered.contains("output too large to preview"));
        assert!(!rendered.contains("    big:\n    ..."));
    }

    #[test]
    fn workflow_dry_run_output_omits_agent_metadata_without_agents_flag() {
        let result = acpus_core::compile_workflow(
            r#"
version: 1
name: dry-run-output
workflow:
  steps:
    - id: ok
      run: program
      cmd: echo ok
"#,
            CompileOptions::default(),
        );
        let ir = result.ir.as_ref().unwrap();
        let agent_metadata = ApplyAgentOverridesResult::default();

        let without_agents = workflow_dry_run_output(
            ir,
            result.schedule.as_ref(),
            &result.diagnostics,
            &agent_metadata,
            false,
        );
        assert!(without_agents.get("agentOverrides").is_none());
        assert!(without_agents.get("submissionWarnings").is_none());

        let with_agents = workflow_dry_run_output(
            ir,
            result.schedule.as_ref(),
            &result.diagnostics,
            &agent_metadata,
            true,
        );
        assert_eq!(with_agents["agentOverrides"], json!({}));
        assert_eq!(with_agents["submissionWarnings"], json!([]));
    }

    #[test]
    fn format_workflow_list_matches_catalog_table_output() {
        let workspace = PathBuf::from("/tmp/workspace");
        let entry = catalog::WorkflowCatalogEntry {
            scope: catalog::WorkflowCatalogScope::Project,
            ref_: Some("project:review".to_string()),
            name: Some("review".to_string()),
            description: None,
            input: None,
            input_keys: Vec::new(),
            path: workspace.join(".acpus/workflows/review.yaml"),
            status: catalog::WorkflowCatalogStatus::Ready,
            diagnostics: Vec::new(),
        };

        assert_eq!(format_workflow_list(&[], &workspace), "No workflows found.");
        assert_eq!(
            format_workflow_list(&[entry], &workspace),
            "SCOPE    STATUS    REF                  NAME                 PATH\nproject  ready     project:review       review               .acpus/workflows/review.yaml"
        );
    }

    #[test]
    fn format_workflow_details_matches_catalog_inspection_output() {
        let entry = catalog::WorkflowCatalogEntry {
            scope: catalog::WorkflowCatalogScope::Project,
            ref_: Some("project:review".to_string()),
            name: Some("review".to_string()),
            description: Some("Review changes".to_string()),
            input: Some(json!({ "branch": "string" })),
            input_keys: vec!["branch".to_string()],
            path: PathBuf::from("/tmp/workflows/review.yaml"),
            status: catalog::WorkflowCatalogStatus::Invalid,
            diagnostics: vec![acpus_core::Diagnostic::warning(
                "TEST_WARNING",
                "check the spec",
                "$.workflow",
            )],
        };

        assert_eq!(
            format_workflow_details(&entry),
            "Workflow: review\nRef: project:review\nScope: project\nStatus: invalid\nPath: /tmp/workflows/review.yaml\nDescription: Review changes\nInputs: branch\n\nDiagnostics:\n  WARNING TEST_WARNING $.workflow: check the spec"
        );
    }

    #[test]
    fn artifact_summary_is_only_shown_for_failed_nodes() {
        assert_eq!(
            format_artifact_summary(acpus_runtime::NodeState::Failed, 2),
            Some("Artifacts: 2 files".to_string())
        );
        assert_eq!(
            format_artifact_summary(acpus_runtime::NodeState::Completed, 2),
            None
        );
        assert_eq!(
            format_artifact_summary(acpus_runtime::NodeState::Failed, 0),
            None
        );
    }

    #[test]
    fn format_run_list_line_includes_updated_source_and_lineage() {
        let mut run = test_run("run-1", "review", acpus_runtime::RunStatus::Completed);
        run.workflow_ref = Some("local:review".to_string());
        assert_eq!(
            format_run_list_line(&acpus_runtime::RunSummary::from(&run)),
            "run-1  review  completed  2026-01-01T09:00:00+00:00  local:review"
        );

        run.workflow_ref = None;
        run.workflow_source_path = Some("/workflows/review.yaml".to_string());
        run.lineage = Some(acpus_runtime::RunLineage {
            source_run_id: "run-0".to_string(),
            fork_origin_node_key: "workflow/build".to_string(),
            inherited_node_count: 2,
        });
        assert_eq!(
            format_run_list_line(&acpus_runtime::RunSummary::from(&run)),
            "run-1  review  completed  2026-01-01T09:00:00+00:00  /workflows/review.yaml  forked from run-0"
        );
    }

    #[test]
    fn format_run_control_messages_match_cli_output() {
        assert_eq!(
            format_run_control_result("run-1", "pause", acpus_runtime::RunStatus::Paused),
            "Run run-1 paused (status: paused)"
        );
        assert_eq!(
            format_run_control_result("run-1", "resume", acpus_runtime::RunStatus::Running),
            "Run run-1 resumed (status: running)"
        );
        assert_eq!(
            format_run_control_result("run-1", "cancel", acpus_runtime::RunStatus::Cancelled),
            "Run run-1 cancelled (status: cancelled)"
        );
        assert_eq!(
            format_run_retry_result("run-1", acpus_runtime::RunStatus::Running),
            "Run run-1 retried (status: running)"
        );
        assert_eq!(
            format_node_action_result(
                "workflow/build",
                "retried",
                acpus_runtime::NodeState::Running
            ),
            "Node workflow/build retried (state: running)"
        );
        assert_eq!(
            format_node_action_result(
                "workflow/gate",
                "signaled",
                acpus_runtime::NodeState::Completed
            ),
            "Node workflow/gate signaled (state: completed)"
        );
    }

    #[test]
    fn format_workflow_background_run_matches_cli_output() {
        let mut run = test_run("run-1", "review", acpus_runtime::RunStatus::Running);
        assert_eq!(
            format_workflow_background_run(&run),
            "Run run-1 started: review\nStatus: running"
        );

        run.workflow_ref = Some("project:review".to_string());
        assert_eq!(
            format_workflow_background_run(&run),
            "Run run-1 started: review\nWorkflow: project:review\nStatus: running"
        );
    }

    #[test]
    fn format_fork_outputs_match_cli_output() {
        let plan = test_fork_plan();
        assert_eq!(
            format_fork_dry_run("source-run", &plan),
            "Fork plan for source-run:\n  Fork Origin: workflow/test (operator-override)\n  Inherited Nodes: 2\n    + workflow/setup\n    + workflow/test"
        );

        let mut fork = ForkRunResponse {
            run: test_run("fork-run", "review", acpus_runtime::RunStatus::Running),
            plan,
        };
        assert_eq!(
            format_fork_background_run("source-run", &fork),
            "Run fork-run forked from source-run\nFork Origin: workflow/test\nInherited: 2 node(s)\nStatus: running"
        );

        fork.run.status = acpus_runtime::RunStatus::Completed;
        assert!(format_fork_background_run("source-run", &fork).ends_with("Status: completed"));
    }

    #[test]
    fn format_run_show_header_includes_duration_and_lineage() {
        let mut run = test_run("run-1", "review", acpus_runtime::RunStatus::Completed);
        let mut node = test_node(
            "workflow/build",
            acpus_core::IrNodeKind::RunProgram,
            acpus_runtime::NodeState::Completed,
        );
        node.started_at = Some(utc("2026-01-01T09:00:00Z"));
        node.completed_at = Some(utc("2026-01-01T09:01:30Z"));
        run.nodes = vec![node];
        run.lineage = Some(acpus_runtime::RunLineage {
            source_run_id: "run-0".to_string(),
            fork_origin_node_key: "workflow/build".to_string(),
            inherited_node_count: 1,
        });

        assert_eq!(
            format_run_show_header(&run),
            "Run run-1  review  completed  1m30s  forked from run-0 (origin=workflow/build, inherited=1)"
        );
    }

    #[test]
    fn run_show_json_omits_rendered_prompts_but_keeps_node_outputs() {
        let mut run = test_run("run-1", "review", acpus_runtime::RunStatus::Running);
        let mut node = test_node(
            "workflow/review",
            acpus_core::IrNodeKind::RunAgent,
            acpus_runtime::NodeState::Completed,
        );
        node.rendered_prompt = Some("Review secret context".to_string());
        node.output = Some(json!({ "verdict": "pass" }));
        node.artifact_refs = vec!["artifact://run-1/workflow/review/output.json".to_string()];
        run.nodes = vec![node];

        let value = run_show_json(&run).unwrap();
        let node = &value["nodes"][0];
        assert!(node.get("renderedPrompt").is_none());
        assert_eq!(node["output"], json!({ "verdict": "pass" }));
        assert_eq!(
            node["artifactRefs"],
            json!(["artifact://run-1/workflow/review/output.json"])
        );
    }

    #[test]
    fn replay_mismatch_kind_text_matches_json_shape() {
        assert_eq!(
            replay_mismatch_kind_text(&acpus_runtime::ReplayMismatchKind::State),
            "state"
        );
        assert_eq!(
            replay_mismatch_kind_text(&acpus_runtime::ReplayMismatchKind::MissingInReplay),
            "missing-in-replay"
        );
        assert_eq!(
            replay_mismatch_kind_text(&acpus_runtime::ReplayMismatchKind::UnexpectedInReplay),
            "unexpected-in-replay"
        );
    }

    #[test]
    fn follow_run_observation_omits_absent_workflow_ref() {
        let mut run = test_run("run-1", "review", acpus_runtime::RunStatus::Running);
        assert_eq!(
            follow_run_observation(&run),
            json!({
                "type": "run",
                "runId": "run-1",
                "status": "running",
                "workflowName": "review",
                "createdAt": "2026-01-01T08:00:00Z"
            })
        );

        run.workflow_ref = Some("local:review".to_string());
        assert_eq!(
            follow_run_observation(&run)["workflowRef"],
            json!("local:review")
        );
    }

    #[test]
    fn format_submission_warning_matches_cli_contract() {
        assert_eq!(
            format_submission_warning(&acpus_core::AgentOverrideWarning {
                code: "AGENT_MODEL_CLEARED".to_string(),
                agent: "reviewer".to_string(),
                message: "model cleared".to_string(),
            }),
            "WARNING AGENT_MODEL_CLEARED reviewer: model cleared"
        );
    }

    #[test]
    fn machine_json_is_compact() {
        assert_eq!(
            machine_json(&json!({ "ok": true, "items": [1, 2] })).unwrap(),
            r#"{"items":[1,2],"ok":true}"#
        );
    }

    #[test]
    fn supervisor_client_clones_preserve_lease_identity() {
        let client = RunSupervisorClient {
            endpoint: "http://127.0.0.1:1".to_string(),
            http: reqwest::Client::new(),
            json_errors: false,
            client_id: "client-1".to_string(),
            client_kind: None,
        };

        let json_client = client.with_json_errors(true);
        assert!(json_client.json_errors);
        assert_eq!(json_client.client_id, "client-1");
        assert_eq!(json_client.client_kind, None);

        let follow_client = json_client.with_client_kind("follow");
        assert!(follow_client.json_errors);
        assert_eq!(follow_client.client_id, "client-1");
        assert_eq!(follow_client.client_kind, Some("follow"));
    }

    #[test]
    fn quiet_flags_parse_for_run_and_fork() {
        let cli = Cli::try_parse_from(["acpus", "workflows", "run", "wf.yaml", "--quiet"]).unwrap();
        match cli.command {
            Commands::Workflows(command) => match command.command {
                WorkflowSubcommand::Run(args) => assert!(args.quiet),
                _ => panic!("expected workflows run"),
            },
            _ => panic!("expected workflows command"),
        }

        let cli =
            Cli::try_parse_from(["acpus", "runs", "fork", "source", "wf.yaml", "--quiet"]).unwrap();
        match cli.command {
            Commands::Runs(command) => match command.command {
                RunSubcommand::Fork(args) => assert!(args.quiet),
                _ => panic!("expected runs fork"),
            },
            _ => panic!("expected runs command"),
        }
    }

    #[test]
    fn visualize_flags_parse_for_run_fork_and_runs_visualize() {
        let cli =
            Cli::try_parse_from(["acpus", "workflows", "run", "wf.yaml", "--visualize"]).unwrap();
        match cli.command {
            Commands::Workflows(command) => match command.command {
                WorkflowSubcommand::Run(args) => assert!(args.visualize),
                _ => panic!("expected workflows run"),
            },
            _ => panic!("expected workflows command"),
        }

        let cli =
            Cli::try_parse_from(["acpus", "runs", "fork", "source", "wf.yaml", "--visualize"])
                .unwrap();
        match cli.command {
            Commands::Runs(command) => match command.command {
                RunSubcommand::Fork(args) => assert!(args.visualize),
                _ => panic!("expected runs fork"),
            },
            _ => panic!("expected runs command"),
        }

        let cli = Cli::try_parse_from(["acpus", "runs", "visualize", "run-1", "--serve", "3000"])
            .unwrap();
        match cli.command {
            Commands::Runs(command) => match command.command {
                RunSubcommand::Visualize { run_id, serve } => {
                    assert_eq!(run_id.as_deref(), Some("run-1"));
                    assert_eq!(serve.as_deref(), Some("3000"));
                }
                _ => panic!("expected runs visualize"),
            },
            _ => panic!("expected runs command"),
        }

        let cli = Cli::try_parse_from(["acpus", "runs", "visualize", "--serve"]).unwrap();
        match cli.command {
            Commands::Runs(command) => match command.command {
                RunSubcommand::Visualize { run_id, serve } => {
                    assert!(run_id.is_none());
                    assert_eq!(serve.as_deref(), Some(""));
                }
                _ => panic!("expected runs visualize"),
            },
            _ => panic!("expected runs command"),
        }
    }

    #[test]
    fn visualize_conflicts_match_cli_contract() {
        assert_eq!(
            reject_conflicting_submission_options(true, true, false),
            Some(
                "--background and --visualize are mutually exclusive.\nHint: choose --background to detach, or --visualize to attach the TUI."
            )
        );
        assert_eq!(
            reject_conflicting_submission_options(false, true, true),
            Some(
                "--visualize and --json are mutually exclusive.\nHint: use --json for machine-readable follow output, or --visualize for the TUI."
            )
        );
        assert_eq!(
            reject_conflicting_submission_options(false, true, false),
            None
        );
    }

    #[test]
    fn cli_error_classifier_preserves_exit_code_and_json_mode() {
        let error = cli_failure(
            EXIT_CLI_ERROR,
            true,
            "--visualize and --json are mutually exclusive",
        );
        assert_eq!(
            classify_cli_error(&error),
            (
                EXIT_CLI_ERROR,
                true,
                Some("--visualize and --json are mutually exclusive".to_string())
            )
        );

        assert_eq!(
            classify_cli_error(&cli_exit(EXIT_DSL_STATIC_ERROR)),
            (EXIT_DSL_STATIC_ERROR, false, None)
        );

        let error = anyhow::anyhow!("workspace supervisor failed to start within 15s");
        assert_eq!(classify_cli_error(&error).0, EXIT_SUPERVISOR_ERROR);

        let error = anyhow::anyhow!("program failed");
        assert_eq!(classify_cli_error(&error).0, EXIT_RUNTIME_ERROR);
    }

    #[test]
    fn api_error_body_maps_fork_rejections_to_dedicated_exit_code() {
        assert_eq!(
            api_error_body(r#"{"kind":"fork-rejected","error":"source Run is running"}"#),
            (EXIT_FORK_REJECTED, "source Run is running".to_string())
        );
        assert_eq!(
            api_error_body(r#"{"error":"Run not found"}"#),
            (EXIT_RUNTIME_ERROR, "Run not found".to_string())
        );
    }

    #[test]
    fn visualizer_listen_validation_matches_cli_contract() {
        assert!(validate_visualizer_listen(None).is_ok());
        assert!(validate_visualizer_listen(Some("")).is_ok());
        assert!(validate_visualizer_listen(Some("3000")).is_ok());
        assert!(validate_visualizer_listen(Some("127.0.0.1:3000")).is_ok());
        assert!(validate_visualizer_listen(Some("host:65536")).is_err());
        assert!(validate_visualizer_listen(Some("run-id-after-serve")).is_err());
    }

    #[test]
    fn file_url_encodes_tui_module_paths() {
        assert_eq!(
            file_url(Path::new("/tmp/acpus tui/dist/#entry.js")),
            "file:///tmp/acpus%20tui/dist/%23entry.js"
        );
    }

    #[test]
    fn run_command_preflight_rejects_bad_visualizer_listen_without_supervisor() {
        let cli =
            Cli::try_parse_from(["acpus", "runs", "visualize", "--serve", "run_abc"]).unwrap();
        let Commands::Runs(command) = cli.command else {
            panic!("expected runs command");
        };

        let error = validate_run_command_before_supervisor(&command.command).unwrap_err();

        assert!(error.to_string().contains("put it before --serve"));
        assert_eq!(classify_cli_error(&error).0, EXIT_CLI_ERROR);
    }

    #[test]
    fn run_command_json_detects_machine_readable_error_mode() {
        let cli = Cli::try_parse_from(["acpus", "runs", "replay", "run-1", "--json"]).unwrap();
        let Commands::Runs(command) = cli.command else {
            panic!("expected runs command");
        };
        assert!(run_command_json(&command.command));

        let cli =
            Cli::try_parse_from(["acpus", "runs", "fork", "run-1", "wf.yaml", "--json"]).unwrap();
        let Commands::Runs(command) = cli.command else {
            panic!("expected runs command");
        };
        assert!(run_command_json(&command.command));

        let cli = Cli::try_parse_from(["acpus", "runs", "visualize", "--serve"]).unwrap();
        let Commands::Runs(command) = cli.command else {
            panic!("expected runs command");
        };
        assert!(!run_command_json(&command.command));
    }

    #[test]
    fn follow_terminal_status_keeps_running_runs_attached() {
        assert!(!is_follow_terminal(acpus_runtime::RunStatus::Running));
        assert!(is_follow_terminal(acpus_runtime::RunStatus::Completed));
        assert!(is_follow_terminal(acpus_runtime::RunStatus::Failed));
        assert!(is_follow_terminal(acpus_runtime::RunStatus::Paused));
        assert!(is_follow_terminal(acpus_runtime::RunStatus::Cancelled));
    }

    #[test]
    fn follow_summary_uses_node_duration_and_completed_output() {
        let mut run = test_run("run-1", "review", acpus_runtime::RunStatus::Completed);
        run.output = Some(json!({ "ok": true }));
        let mut node = test_node(
            "workflow/build",
            acpus_core::IrNodeKind::RunProgram,
            acpus_runtime::NodeState::Completed,
        );
        node.started_at = Some(utc("2026-01-01T09:00:00Z"));
        node.completed_at = Some(utc("2026-01-01T09:01:30Z"));
        run.nodes = vec![node];

        assert_eq!(compute_run_duration_ms(&run), 90_000);
        assert_eq!(
            format_follow_summary(&run).unwrap(),
            "✓ Run run-1 review completed 1m30s\n\n  Output:\n    ok: true"
        );
    }

    #[test]
    fn should_show_node_hides_duplicate_terminal_container_errors() {
        let mut container = test_node(
            "workflow/group",
            acpus_core::IrNodeKind::Pipeline,
            acpus_runtime::NodeState::Failed,
        );
        container.error = Some("boom".to_string());
        let mut child = test_node(
            "workflow/group/build",
            acpus_core::IrNodeKind::RunProgram,
            acpus_runtime::NodeState::Failed,
        );
        child.error = Some("boom".to_string());
        assert!(!should_show_node(&container, &[container.clone(), child]));

        container.state = acpus_runtime::NodeState::Running;
        assert!(should_show_node(&container, &[container.clone()]));

        container.state = acpus_runtime::NodeState::Failed;
        container.error = Some("container boom".to_string());
        assert!(should_show_node(&container, &[container.clone()]));
    }

    #[test]
    fn format_node_lines_includes_error_and_failed_artifact_summary() {
        let mut node = test_node(
            "workflow/build",
            acpus_core::IrNodeKind::RunProgram,
            acpus_runtime::NodeState::Failed,
        );
        node.error = Some("boom".to_string());
        node.artifact_refs = vec![
            "artifact://stdout".to_string(),
            "artifact://stderr".to_string(),
        ];

        assert_eq!(
            format_node_lines(&node),
            vec![
                "  ◆ workflow/build  [program]  failed".to_string(),
                "    Error: boom".to_string(),
                "    Artifacts: 2 files".to_string()
            ]
        );
    }

    #[test]
    fn running_agent_lines_include_activity_summary() {
        let mut node = test_node(
            "workflow/review",
            acpus_core::IrNodeKind::RunAgent,
            acpus_runtime::NodeState::Running,
        );
        node.agent_telemetry = Some(test_agent_telemetry());

        let lines = format_node_lines_at(&node, utc("2026-01-01T09:00:12Z"));

        assert!(lines.contains(&"    Activity: updated=12s ago; tool_calls=2; recent=Read, Bash; context=25k/190k; tokens=12k".to_string()));
    }

    #[test]
    fn follow_node_observation_keeps_machine_readable_fields() {
        let mut node = test_node(
            "workflow/build",
            acpus_core::IrNodeKind::RunProgram,
            acpus_runtime::NodeState::Completed,
        );
        node.started_at = Some(utc("2026-01-01T09:00:00Z"));
        node.completed_at = Some(utc("2026-01-01T09:00:01Z"));
        node.output = Some(json!({ "output": { "ok": true }, "exit_code": 0 }));
        node.artifact_refs = vec!["artifact://stdout".to_string()];

        assert_eq!(
            follow_node_observation(&node),
            json!({
                "type": "node",
                "nodeKey": "workflow/build",
                "state": "completed",
                "kind": "run.program",
                "attempt": 1,
                "startedAt": "2026-01-01T09:00:00Z",
                "completedAt": "2026-01-01T09:00:01Z",
                "artifactRefs": ["artifact://stdout"],
                "output": { "output": { "ok": true }, "exit_code": 0 }
            })
        );
    }

    #[test]
    fn follow_node_observation_includes_agent_telemetry() {
        let mut node = test_node(
            "workflow/review",
            acpus_core::IrNodeKind::RunAgent,
            acpus_runtime::NodeState::Running,
        );
        node.agent_telemetry = Some(test_agent_telemetry());

        let event = follow_node_observation(&node);

        assert_eq!(event["agentTelemetry"]["currentAttempt"], json!(1));
        assert_eq!(
            event["agentTelemetry"]["attempts"][0]["tools"]["totalToolCallCount"],
            json!(2)
        );
    }

    #[test]
    fn format_duration_from_ms_matches_cli_buckets() {
        assert_eq!(format_duration_from_ms(500), "<1s");
        assert_eq!(format_duration_from_ms(59_999), "59s");
        assert_eq!(format_duration_from_ms(90_000), "1m30s");
        assert_eq!(format_duration_from_ms(7_200_000), "2h");
        assert_eq!(format_duration_from_ms(172_800_000), "2d");
    }

    #[test]
    fn format_node_line_uses_compact_glyph_kind_and_state() {
        let now = utc("2026-01-01T09:01:30Z");
        let mut node = test_node(
            "workflow/review",
            acpus_core::IrNodeKind::RunAgent,
            acpus_runtime::NodeState::Completed,
        );
        node.started_at = Some(utc("2026-01-01T09:00:00Z"));
        node.completed_at = Some(now);
        assert_eq!(
            format_node_line_at(&node, now),
            "  ✓ workflow/review  [agent]  1m30s"
        );

        node.node_key = "workflow/gate".to_string();
        node.kind = acpus_core::IrNodeKind::RunSignal;
        node.state = acpus_runtime::NodeState::Awaiting;
        node.completed_at = None;
        assert_eq!(
            format_node_line_at(&node, utc("2026-01-01T09:00:05Z")),
            "  ⏳ workflow/gate  [signal]  awaiting  5s"
        );

        node.node_key = "workflow/build".to_string();
        node.kind = acpus_core::IrNodeKind::RunProgram;
        node.state = acpus_runtime::NodeState::Failed;
        node.attempt = 3;
        node.started_at = None;
        assert_eq!(
            format_node_line_at(&node, now),
            "  ◆ workflow/build  [program]  failed  attempt=3"
        );
    }

    #[test]
    fn awaiting_signal_details_show_prompt_schema_and_command() {
        let source = r#"
version: 1
name: signal-details
workflow:
  steps:
    - id: gate
      run: signal
      prompt: Decide on ${{ input.topic }}
      output:
        decision: string
        confidence?: number
"#;
        let ir = acpus_core::compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let index = index_ir_nodes_by_path(&ir);
        let node = acpus_runtime::NodeExecutionState {
            node_key: "workflow/gate".to_string(),
            node_id: "gate".to_string(),
            kind: acpus_core::IrNodeKind::RunSignal,
            definition_hash: None,
            state: acpus_runtime::NodeState::Awaiting,
            attempt: 1,
            started_at: None,
            completed_at: None,
            error: None,
            failure_kind: None,
            input: None,
            output: None,
            artifact_refs: Vec::new(),
            rendered_prompt: Some("Decide on release readiness".to_string()),
            rendered_session_key: None,
            dynamic_context: None,
            agent_telemetry: None,
        };

        let lines = format_awaiting_signal("run-sig", &node, index.get("workflow/gate"));

        assert!(lines.contains(&"    Prompt:".to_string()));
        assert!(lines.contains(&"      Decide on release readiness".to_string()));
        assert!(lines.contains(&"    Expected payload:".to_string()));
        assert!(lines.contains(&"      decision: string (required)".to_string()));
        assert!(lines.contains(&"      confidence: number (optional)".to_string()));
        assert!(
            lines.contains(
                &"    Deliver: acpus runs signal run-sig --node workflow/gate --payload '{...}'"
                    .to_string()
            )
        );
    }

    #[test]
    fn run_control_transition_validation_matches_spec() {
        use acpus_runtime::RunStatus::*;

        assert!(validate_control_transition(Running, Paused).is_ok());
        assert!(validate_control_transition(Running, Cancelled).is_ok());
        assert!(validate_control_transition(Paused, Cancelled).is_ok());
        assert!(validate_control_transition(Completed, Paused).is_err());
        assert!(validate_control_transition(Failed, Cancelled).is_err());
    }

    fn test_fork_plan() -> acpus_runtime::ForkPlan {
        acpus_runtime::ForkPlan {
            source_run_id: "source-run".to_string(),
            inherited_node_keys: vec!["workflow/setup".to_string(), "workflow/test".to_string()],
            default_fork_origin_node_key: "workflow/publish".to_string(),
            fork_origin_node_key: "workflow/test".to_string(),
            boundary_reason: "operator-override".to_string(),
        }
    }

    fn test_run(
        run_id: &str,
        workflow_name: &str,
        status: acpus_runtime::RunStatus,
    ) -> acpus_runtime::RunState {
        acpus_runtime::RunState {
            run_id: run_id.to_string(),
            workflow_name: workflow_name.to_string(),
            workflow_ref: None,
            workflow_source_path: None,
            status,
            ir_digest: "ir".to_string(),
            input_digest: "input".to_string(),
            created_at: utc("2026-01-01T08:00:00Z"),
            updated_at: utc("2026-01-01T09:00:00Z"),
            run_attempt: 1,
            hook_config_hash: None,
            skip_hooks: false,
            output: None,
            error: None,
            lineage: None,
            agent_overrides: BTreeMap::new(),
            submission_warnings: Vec::new(),
            nodes: Vec::new(),
        }
    }

    fn test_node(
        node_key: &str,
        kind: acpus_core::IrNodeKind,
        state: acpus_runtime::NodeState,
    ) -> acpus_runtime::NodeExecutionState {
        acpus_runtime::NodeExecutionState {
            node_key: node_key.to_string(),
            node_id: node_key.rsplit('/').next().unwrap().to_string(),
            kind,
            definition_hash: None,
            state,
            attempt: 1,
            started_at: None,
            completed_at: None,
            error: None,
            failure_kind: None,
            input: None,
            output: None,
            artifact_refs: Vec::new(),
            rendered_prompt: None,
            rendered_session_key: None,
            dynamic_context: None,
            agent_telemetry: None,
        }
    }

    fn test_agent_telemetry() -> acpus_runtime::AgentTelemetry {
        acpus_runtime::AgentTelemetry {
            current_attempt: 1,
            attempts: vec![acpus_runtime::AgentAttemptTelemetry {
                attempt: 1,
                state: acpus_runtime::AgentAttemptTelemetryState::Running,
                started_at: "2026-01-01T09:00:00Z".to_string(),
                updated_at: "2026-01-01T09:00:00Z".to_string(),
                completed_at: None,
                context: Some(acpus_runtime::AgentContextUsage {
                    used: 25_000,
                    size: 190_000,
                    updated_at: "2026-01-01T09:00:00Z".to_string(),
                }),
                token_usage: Some(acpus_runtime::AgentTokenUsage {
                    source: "prompt_response".to_string(),
                    input_tokens: None,
                    output_tokens: None,
                    cached_read_tokens: None,
                    cached_write_tokens: None,
                    thought_tokens: None,
                    total_tokens: Some(12_000),
                }),
                input: None,
                output: None,
                tools: acpus_runtime::AgentToolsTelemetry {
                    total_tool_call_count: 2,
                    dropped_tool_call_count: 0,
                    recent_calls: vec![
                        acpus_runtime::AgentToolCallTelemetry {
                            tool_call_id: "tool-1".to_string(),
                            title: Some("Read".to_string()),
                            status: Some("completed".to_string()),
                            kind: None,
                            tool_name: None,
                            started_at: "2026-01-01T09:00:00Z".to_string(),
                            updated_at: "2026-01-01T09:00:00Z".to_string(),
                            completed_at: Some("2026-01-01T09:00:01Z".to_string()),
                        },
                        acpus_runtime::AgentToolCallTelemetry {
                            tool_call_id: "tool-2".to_string(),
                            title: None,
                            status: Some("running".to_string()),
                            kind: None,
                            tool_name: Some("Bash".to_string()),
                            started_at: "2026-01-01T09:00:00Z".to_string(),
                            updated_at: "2026-01-01T09:00:00Z".to_string(),
                            completed_at: None,
                        },
                    ],
                },
                acpx_record_id: None,
                cwd: Some("/tmp/work".to_string()),
            }],
        }
    }

    fn utc(value: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[tokio::test]
    async fn validates_existing_workspace_supervisor_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let metadata_path = supervisor_metadata_path(&store);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let server = tokio::spawn({
            let store = store.clone();
            async move {
                Supervisor::new(store).serve(addr).await.unwrap();
            }
        });

        let metadata = wait_for_supervisor_metadata(&metadata_path).await;
        assert_eq!(
            validate_supervisor_metadata(&metadata_path, dir.path())
                .await
                .unwrap()
                .endpoint,
            metadata.endpoint
        );
        assert!(
            validate_supervisor_metadata(&metadata_path, other.path())
                .await
                .is_none()
        );

        server.abort();
    }

    #[test]
    fn supervisor_lock_removes_stale_marker() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(state_dir.join("supervisor.lock"), b"stale").unwrap();

        let lock = SupervisorLock::acquire_with(
            &state_dir,
            Duration::ZERO,
            Duration::from_millis(20),
            Duration::from_millis(1),
        )
        .unwrap();

        assert!(state_dir.join("supervisor.lock").exists());
        drop(lock);
        assert!(!state_dir.join("supervisor.lock").exists());
    }

    #[test]
    fn supervisor_lock_keeps_fresh_marker_until_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(state_dir.join("supervisor.lock"), b"fresh").unwrap();

        let started = Instant::now();
        let error = match SupervisorLock::acquire_with(
            &state_dir,
            Duration::from_secs(60),
            Duration::from_millis(20),
            Duration::from_millis(1),
        ) {
            Ok(_) => panic!("fresh lock should time out"),
            Err(error) => error,
        };

        assert!(started.elapsed() >= Duration::from_millis(20));
        assert_eq!(
            error.to_string(),
            "timed out waiting for workspace supervisor lock"
        );
        assert!(state_dir.join("supervisor.lock").exists());
    }

    async fn wait_for_supervisor_metadata(path: &Path) -> SupervisorMetadata {
        for _ in 0..50 {
            if let Some(metadata) = read_supervisor_metadata(path) {
                return metadata;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("supervisor metadata was not written");
    }
}
