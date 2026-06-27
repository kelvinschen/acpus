// Acpus Hook System — shared type definitions.
//
// Hooks are a runtime platform-layer capability, independent of any Workflow
// Spec. They inject external context before Agent/Program execution (injectors)
// and observe Run/Node lifecycle changes (events). These types are shared
// between the runtime (loader/runner/journal/interpreter) and the CLI.

/** Injector hook names (synchronous, blocking, pure context injection). */
export type InjectorName = "beforeAgentExec" | "beforeProgramExec";

/** Event hook names (asynchronous observation, never adjudicate). */
export type EventName =
  | "beforeRun"
  | "afterRun"
  | "onNodeStart"
  | "onNodeComplete"
  | "onNodeError"
  | "onNodePaused"
  | "onNodeCancelled"
  | "onStateChange";

export const INJECTOR_NAMES: readonly InjectorName[] = ["beforeAgentExec", "beforeProgramExec"];

export const EVENT_NAMES: readonly EventName[] = [
  "beforeRun",
  "afterRun",
  "onNodeStart",
  "onNodeComplete",
  "onNodeError",
  "onNodePaused",
  "onNodeCancelled",
  "onStateChange"
];

/** Behavior when an injector handler times out, exits non-zero, or fails to parse. */
export type HookOnFailure = "fail" | "skip";

/** Fields common to every command handler. */
export interface HookHandlerBase {
  /** Duration string (e.g. "5s"); defaults: injectors 5s, events 30s. */
  timeout?: string;
  /** Shell-form command executed for this handler. */
  command: string;
  /** Extra environment variables for the handler process. */
  env?: Record<string, string>;
  /** Working directory; defaults to the process working directory. */
  cwd?: string;
}

export interface InjectorHookHandler extends HookHandlerBase {
  /** Failure policy. Default "fail". */
  on_failure?: HookOnFailure;
}

export interface EventHookHandler extends HookHandlerBase {
  /** If true, wait for the event handler before continuing. Default false. */
  sync?: boolean;
}

export type HookHandler = InjectorHookHandler | EventHookHandler;

/** A full hook configuration as authored in hooks.yaml. */
export interface HookConfig {
  injectors?: Partial<Record<InjectorName, InjectorHookHandler[]>>;
  events?: Partial<Record<EventName, EventHookHandler[]>>;
}

/** Frozen, merged configuration snapshot persisted per Run. */
export interface HookConfigSnapshot {
  /** "sha256:..." over the canonical merged configuration JSON. */
  hash: string;
  /** Absolute global config path (when it contributed). */
  globalConfigPath?: string;
  /** Absolute project config path (when it contributed). */
  projectConfigPath?: string;
  mergedConfig: HookConfig;
}

/** JSON payload handed to every handler on stdin. */
export interface HookPayload {
  // Common
  hook_event_name: string;
  run_id: string;
  workflow_name: string;
  workflow_source_path: string;
  workflow_source_dir: string;
  cwd: string;
  timestamp: string;

  // Node-level
  node_key?: string;
  node_id?: string;
  node_kind?: string;
  node_attempt?: number;
  parent_node_key?: string;
  parent_node_kind?: string;

  // Dynamic context
  loop_round?: number;
  fanout_item_id?: string;
  fanout_item_index?: number;
  parallel_lane_id?: string;

  // State change
  from_state?: string;
  to_state?: string;

  // Error
  error?: string;
  failure_kind?: string;

  // Output
  output?: unknown;
  duration_ms?: number;

  // Agent-specific
  agent_use?: string;
  agent_model?: string;
  agent_type?: string;
  agent_policy?: string;
  prompt?: string;
  session_key?: string;
  is_continuation?: boolean;
  is_retry?: boolean;
  agent_exit_code?: number;
  agent_response_text?: string;
  agent_telemetry?: HookAgentTelemetry;

  // Program-specific
  command?: string;
  shell?: boolean;
  subprocess_env?: Record<string, string>;
  exit_code?: number;
  stdout?: string;
  stderr?: string;

  // Run-level
  input?: Record<string, unknown>;
  run_status?: string;
  run_attempt?: number;
  ir_digest?: string;

  // Composite container
  join_strategy?: string;
  max_concurrency?: number;
  items_count?: number;
  successful_lanes?: number;
  failed_lanes?: number;
  max_iterations?: number;
  iterations_completed?: number;
  subworkflow_spec_path?: string;
  subworkflow_name?: string;
  signal_timeout?: string;
  signal_on_timeout?: string;
}

/** Compact Agent telemetry exposed to Agent node event handlers. */
export interface HookAgentTelemetry {
  attempt: number;
  state: "running" | "completed" | "failed" | "paused" | "cancelled";
  updated_at: string;
  completed_at?: string;
  context?: {
    used: number;
    size: number;
    updated_at: string;
  };
  token_usage?: {
    source: "prompt_response";
    input_tokens?: number;
    output_tokens?: number;
    cached_read_tokens?: number;
    cached_write_tokens?: number;
    thought_tokens?: number;
    total_tokens?: number;
  };
}

/** Value a beforeAgentExec injector handler may return to influence execution. */
export interface AgentInjectorResult {
  /** Prepended to the rendered Agent prompt before the executor call. */
  prependPrompt?: string;
}

/** Value a beforeProgramExec injector handler may return to influence execution. */
export interface ProgramInjectorResult {
  /** Merged into the Program subprocess environment. */
  env?: Record<string, string>;
}

/** Value an injector handler may return to influence execution. */
export type InjectorResult = AgentInjectorResult | ProgramInjectorResult;

/** One append-only journal record per injector handler invocation. */
export interface HookJournalEntry {
  sequence: number;
  node_key: string;
  injector: InjectorName;
  handler_index: number;
  node_attempt: number;
  is_retry: boolean;
  /** Full prompt prefix injected (Agent injectors only; null when none). */
  prepend_prompt: string | null;
  /** Full resolved env injected (null when none). */
  env: Record<string, string> | null;
  timestamp: string;
  duration_ms: number;
}
