import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { IconUserOutline16 } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { AgentPresetView } from "../remote/types.js";
import acpusDshLogo from "../../assets/logo-with-dsh.svg";
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
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        close();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [close, open]);

  useEffect(() => {
    if (!enabled && open) close();
  }, [close, enabled, open]);

  useEffect(() => () => {
    ++request.current;
  }, []);

  if (!enabled) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    close(true);
  };

  return (
    <div
      ref={rootRef}
      className="acpus-preset-action"
      onKeyDown={onKeyDown}
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
        <IconUserOutline16 size={14} />
        <span>Agent Presets</span>
      </button>
      {open && (
        <div
          className="acpus-preset-popover"
          role="dialog"
          aria-label="Agent Presets"
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

function PresetRow({ preset }: { preset: AgentPresetView }) {
  return (
    <li className="acpus-preset-row">
      <span className="acpus-preset-content">
        <span className="acpus-preset-heading">
          <code>{preset.id}</code>
          {preset.scope === "host" && <span className="acpus-preset-builtin">内置</span>}
        </span>
        <span className="acpus-preset-guidance">{preset.guidance}</span>
      </span>
    </li>
  );
}
