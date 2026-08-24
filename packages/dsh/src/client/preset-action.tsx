import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AgentPresetView } from "../remote/types.js";
import acpusDshLogo from "../../assets/logo-with-dsh.svg";
import { agentIcon } from "./agent-icons.js";
import type { AcpusClientState } from "./state.js";

type PresetCatalogReader = Pick<AcpusClientState, "readAgentPresets">;

export type AcpusPresetActionProps =
  & PropsRuntime<"conversation.session.header.actions">
  & { acpus: PresetCatalogReader };

export type AcpusBrandLabelProps =
  PropsRuntime<"conversation.session.header.actions">;

type PresetReadState =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; presets: AgentPresetView[] };

export function AcpusBrandLabel({
  sessionId,
  useSessions,
}: AcpusBrandLabelProps) {
  const enabled = useSessions(
    sessions => sessions.byId[sessionId]?.agentPreset === "acpus",
  );
  if (!enabled) return null;
  return (
    <img
      className="acpus-header-brand"
      src={acpusDshLogo}
      alt="Acpus × DSH"
      title="Acpus 模式：将任务交给 ACP 兼容的第三方 Agent，由 Acpus 持久化编排、调度与恢复；DSH 负责规划、监督和与你沟通。"
    />
  );
}

export function AcpusPresetAction({
  acpus,
  sessionId,
  useSessions,
}: AcpusPresetActionProps) {
  const enabled = useSessions(
    sessions => sessions.byId[sessionId]?.agentPreset === "acpus",
  );
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<PresetReadState>({ status: "idle" });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const load = useCallback(() => {
    const current = ++request.current;
    setRead({ status: "loading" });
    void acpus.readAgentPresets().then(
      presets => {
        if (request.current === current) setRead({ status: "ready", presets });
      },
      () => {
        if (request.current === current) setRead({ status: "error" });
      },
    );
  }, [acpus]);

  const close = useCallback((restoreFocus = false) => {
    ++request.current;
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus({ preventScroll: true });
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        close();
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [close, open]);

  useEffect(() => {
    if (!enabled && open) close();
  }, [close, enabled, open]);

  useEffect(() => () => {
    ++request.current;
  }, []);

  if (!enabled) return null;

  return (
    <div
      ref={rootRef}
      className="acpus-preset-action"
    >
      <button
        ref={triggerRef}
        type="button"
        className="acpus-preset-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setOpen(true);
          load();
        }}
      >
        <RobotIcon />
        <span>Agent Presets</span>
      </button>
      {open && (
        <div
          ref={dialogRef}
          className="acpus-preset-popover"
          role="dialog"
          aria-label="Agent Presets"
          tabIndex={-1}
        >
          {read.status === "loading" && (
            <div className="acpus-preset-read-state" role="status">
              加载 Agent Presets…
            </div>
          )}
          {read.status === "error" && (
            <div className="acpus-preset-read-state is-error" role="alert">
              <span>Agent Presets 加载失败</span>
              <button type="button" onClick={load}>重试</button>
            </div>
          )}
          {read.status === "ready" && (
            <ul className="acpus-preset-list">
              {read.presets.map(preset => (
                <PresetRow key={preset.id} preset={preset} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function RobotIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  );
}

function PresetRow({ preset }: { preset: AgentPresetView }) {
  const identity = "use" in preset.agent
    ? { label: "Agent", value: preset.agent.use, icon: agentIcon(preset.agent.use) }
    : { label: "Command", value: preset.agent.command, icon: agentIcon(undefined) };
  const iconName = "use" in preset.agent ? identity.icon.name : "Custom command";
  return (
    <li className="acpus-preset-row">
      <span
        className="acpus-preset-agent-icon"
        aria-hidden="true"
        title={iconName}
      >
        <img src={identity.icon.source} alt="" />
      </span>
      <span className="acpus-preset-content">
        <span className="acpus-preset-heading">
          <code>{preset.id}</code>
          <span className="acpus-preset-scope">
            {preset.scope === "host" ? "内置" : preset.scope === "global" ? "全局" : "项目"}
          </span>
        </span>
        <span className="acpus-preset-meta">
          <span>
            <b>{identity.label}</b>
            <code>{identity.value}</code>
          </span>
          <span>
            <b>Model</b>
            {preset.agent.model === undefined
              ? <span>—</span>
              : <code>{preset.agent.model}</code>}
          </span>
          <span>
            <b>Config</b>
            {preset.agent.config === undefined
              ? <span>—</span>
              : <code>{formatConfig(preset.agent.config)}</code>}
          </span>
        </span>
        <span className="acpus-preset-guidance">{preset.guidance}</span>
      </span>
    </li>
  );
}

function formatConfig(
  config: NonNullable<AgentPresetView["agent"]["config"]>,
): string {
  return `{${config.map(entry =>
    `${JSON.stringify(entry.key)}:${JSON.stringify(entry.value)}`
  ).join(",")}}`;
}
