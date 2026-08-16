import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { IconUserOutline16 } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { AgentProfileView } from "../remote/types.js";
import acpusDshLogo from "../../assets/logo-with-dsh.svg";
import { agentIcon } from "./agent-icons.js";
import type { AcpusClientState } from "./state.js";

type ProfileCatalogReader = Pick<AcpusClientState, "readAgentProfiles">;

export type AcpusProfileActionProps =
  & PropsRuntime<"conversation.session.header.actions">
  & { acpus: ProfileCatalogReader };

export type AcpusBrandLabelProps =
  PropsRuntime<"conversation.session.header.actions">;

type ProfileReadState =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; profiles: AgentProfileView[] };

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

export function AcpusProfileAction({
  acpus,
  sessionId,
  useSessions,
}: AcpusProfileActionProps) {
  const enabled = useSessions(
    sessions => sessions.byId[sessionId]?.agentPreset === "acpus",
  );
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<ProfileReadState>({ status: "idle" });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const request = useRef(0);

  const load = useCallback(() => {
    const current = ++request.current;
    setRead({ status: "loading" });
    void acpus.readAgentProfiles().then(
      profiles => {
        if (request.current === current) setRead({ status: "ready", profiles });
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
      className="acpus-profile-action"
      onKeyDown={onKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className="acpus-profile-trigger"
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
        <span>Agent Profiles</span>
      </button>
      {open && (
        <div
          className="acpus-profile-popover"
          role="dialog"
          aria-label="Agent Profiles"
        >
          {read.status === "loading" && (
            <div className="acpus-profile-read-state" role="status">
              加载 Agent Profiles…
            </div>
          )}
          {read.status === "error" && (
            <div className="acpus-profile-read-state is-error" role="alert">
              <span>Agent Profiles 加载失败</span>
              <button type="button" onClick={load}>重试</button>
            </div>
          )}
          {read.status === "ready" && (
            <ul className="acpus-profile-list">
              {read.profiles.map(profile => (
                <ProfileRow key={profile.id} profile={profile} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ProfileRow({ profile }: { profile: AgentProfileView }) {
  const icon = agentIcon(profile.use);
  return (
    <li className="acpus-profile-row">
      <span
        className="acpus-profile-agent-icon"
        role="img"
        aria-label={`Agent: ${icon.name}`}
        title={icon.name}
      >
        <img src={icon.source} alt="" />
      </span>
      <span className="acpus-profile-content">
        <span className="acpus-profile-heading">
          <code>{profile.id}</code>
          {profile.builtIn && <span className="acpus-profile-builtin">内置</span>}
        </span>
        <span className="acpus-profile-meta">
          <span><b>use</b><code>{profile.use}</code></span>
          {profile.model !== undefined && (
            <span><b>model</b><code>{profile.model}</code></span>
          )}
        </span>
        <span className="acpus-profile-guidance">{profile.guidance}</span>
      </span>
    </li>
  );
}
