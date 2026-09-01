(() => {
  "use strict";

  const elements = {
    name: document.querySelector("#team-name"),
    goal: document.querySelector("#team-goal"),
    connection: document.querySelector("#connection"),
    status: document.querySelector("#team-status"),
    summary: document.querySelector("#summary"),
    timeline: document.querySelector("#timeline"),
    tasks: document.querySelector("#tasks"),
    events: document.querySelector("#events"),
    filter: document.querySelector("#channel-filter"),
    inspector: document.querySelector("#inspector"),
  };

  let latest;
  let selected;
  let timer;

  elements.filter.addEventListener("change", () => latest && renderEvents(latest.inspection));

  async function refresh() {
    try {
      const response = await fetch("/api/team", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "Inspection failed.");
      elements.connection.textContent = payload.phase === "settled" ? "Final snapshot" : "Live";
      elements.connection.className = `connection ${payload.phase}`;
      if (payload.inspection) {
        latest = payload;
        render(payload);
      } else {
        renderStarting(payload.phase);
      }
      if (payload.phase === "settled" && timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    } catch {
      elements.connection.textContent = latest ? "Reconnecting · last snapshot shown" : "Reconnecting";
      elements.connection.className = "connection disconnected";
    }
  }

  function renderStarting(phase) {
    elements.status.textContent = title(phase);
    elements.status.className = `status-pill ${phase}`;
  }

  function render(payload) {
    const inspection = payload.inspection;
    const team = inspection.team;
    elements.name.textContent = team.name;
    elements.goal.textContent = team.goal;
    elements.status.textContent = title(team.status);
    elements.status.className = `status-pill ${team.status}`;
    renderSummary(inspection);
    renderTimeline(inspection);
    renderTasks(inspection);
    renderEvents(inspection);
    renderSelection(inspection);
  }

  function renderSummary(inspection) {
    const completed = inspection.tasks.filter(task => task.status === "completed").length;
    const turns = inspection.members.reduce((total, member) => total + member.turnCount, 0);
    const end = inspection.team.completedAt ?? new Date().toISOString();
    const values = [
      ["Duration", duration(inspection.team.createdAt, end)],
      ["Tasks", `${completed} / ${inspection.tasks.length}`],
      ["Members", String(inspection.members.length)],
      ["Turns", String(turns)],
    ];
    elements.summary.replaceChildren(...values.map(([label, value]) => {
      const card = node("article", "summary-card");
      card.append(node("span", "summary-label", label), node("strong", "summary-value", value));
      return card;
    }));
  }

  function renderTimeline(inspection) {
    const endTime = Date.parse(inspection.team.completedAt ?? new Date().toISOString());
    const times = [Date.parse(inspection.team.createdAt), endTime];
    for (const turn of inspection.turns) {
      times.push(Date.parse(turn.startedAt));
      if (turn.finishedAt) times.push(Date.parse(turn.finishedAt));
    }
    for (const event of inspection.events) times.push(Date.parse(event.createdAt));
    const start = Math.min(...times.filter(Number.isFinite));
    const end = Math.max(start + 1_000, ...times.filter(Number.isFinite));
    const span = end - start;
    const members = new Map(inspection.members.map(member => [member.id, member.name]));
    const lanes = [{ id: undefined, name: "Team", status: inspection.team.status }, ...inspection.members];
    elements.timeline.className = "timeline";
    elements.timeline.replaceChildren(...lanes.map(lane => {
      const row = node("div", "timeline-row");
      const label = node("div", "timeline-label");
      label.append(node("strong", "", lane.name), node("span", "", title(lane.status)));
      const track = node("div", "timeline-track");
      track.setAttribute("role", "group");
      track.setAttribute("aria-label", `${lane.name} activity`);
      const laneTurns = lane.id === undefined ? [] : inspection.turns.filter(turn => turn.memberId === lane.id);
      for (const turn of laneTurns) {
        const left = percent(Date.parse(turn.startedAt), start, span);
        const right = percent(Date.parse(turn.finishedAt ?? new Date().toISOString()), start, span);
        const button = selectable("timeline-turn", `Turn ${title(turn.status)}`, () => select("turn", turn.id));
        button.style.left = `${left}%`;
        button.style.width = `${Math.max(1.2, right - left)}%`;
        button.dataset.status = turn.status;
        track.append(button);
      }
      const laneEvents = inspection.events.filter(event => event.channel !== "acp"
        && (lane.id === undefined ? event.memberId === undefined : event.memberId === lane.id));
      for (const event of laneEvents) {
        const button = selectable(`timeline-event ${event.channel}`, eventLabel(event, members), () => select("event", event.sequence));
        button.style.left = `${percent(Date.parse(event.createdAt), start, span)}%`;
        track.append(button);
      }
      if (inspection.team.status === "active") track.append(node("i", "timeline-now"));
      row.append(label, track);
      return row;
    }));
  }

  function renderTasks(inspection) {
    if (inspection.tasks.length === 0) {
      elements.tasks.className = "task-list empty-state";
      elements.tasks.textContent = "No tasks yet.";
      return;
    }
    const members = new Map(inspection.members.map(member => [member.id, member.name]));
    const tasks = new Map(inspection.tasks.map(task => [task.id, task]));
    elements.tasks.className = "task-list";
    elements.tasks.replaceChildren(...inspection.tasks.map(task => {
      const button = selectable("task-card", task.subject, () => select("task", task.id));
      button.dataset.status = task.status;
      const owner = task.claimedByMemberId ?? task.assignedMemberId;
      const dependencies = task.dependencies.map(id => tasks.get(id)?.subject ?? shortId(id));
      button.append(
        node("span", `task-state ${task.status}`, title(task.status)),
        node("strong", "task-subject", task.subject),
        node("span", "task-owner", owner ? members.get(owner) ?? shortId(owner) : "Unassigned"),
      );
      if (dependencies.length > 0) button.append(node("span", "task-dependencies", `Depends on: ${dependencies.join(", ")}`));
      if (task.blocked) button.append(node("span", "task-blocked", `Blocked by ${task.blockedBy.length}`));
      return button;
    }));
  }

  function renderEvents(inspection) {
    const filter = elements.filter.value;
    const members = new Map(inspection.members.map(member => [member.id, member.name]));
    const events = inspection.events
      .filter(event => filter === "all" || event.channel === filter)
      .slice()
      .reverse();
    elements.events.replaceChildren(...events.map(event => {
      const item = node("li", "event-item");
      const button = selectable("event-button", eventLabel(event, members), () => select("event", event.sequence));
      button.append(
        node("span", `event-channel ${event.channel}`, event.channel.toUpperCase()),
        node("strong", "event-type", event.type.replaceAll("_", " ")),
        node("span", "event-member", event.memberId ? members.get(event.memberId) ?? shortId(event.memberId) : "Team"),
        node("time", "event-time", clock(event.createdAt)),
      );
      item.append(button);
      return item;
    }));
  }

  function select(kind, id) {
    selected = { kind, id };
    if (latest) renderSelection(latest.inspection);
  }

  function renderSelection(inspection) {
    if (!selected) return;
    let value;
    if (selected.kind === "task") value = inspection.tasks.find(item => item.id === selected.id);
    if (selected.kind === "turn") value = inspection.turns.find(item => item.id === selected.id);
    if (selected.kind === "event") {
      const event = inspection.events.find(item => item.sequence === selected.id);
      if (event) {
        value = {
          event,
          member: inspection.members.find(item => item.id === event.memberId),
          task: inspection.tasks.find(item => item.id === event.taskId),
          message: inspection.messages.find(item => item.id === event.messageId),
          turn: inspection.turns.find(item => item.id === event.turnId),
        };
      }
    }
    elements.inspector.textContent = value ? JSON.stringify(value, null, 2) : "The selected item is no longer in the latest snapshot.";
  }

  function eventLabel(event, members) {
    const actor = event.memberId ? members.get(event.memberId) ?? shortId(event.memberId) : "Team";
    return `${actor}: ${event.type.replaceAll("_", " ")}`;
  }

  function selectable(className, label, action) {
    const button = node("button", className);
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", action);
    return button;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function percent(value, start, span) {
    return Math.max(0, Math.min(100, ((value - start) / span) * 100));
  }

  function duration(start, end) {
    const seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function clock(value) {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function shortId(value) {
    return value.length > 15 ? `${value.slice(0, 12)}…` : value;
  }

  function title(value) {
    return String(value).replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
  }

  void refresh();
  timer = window.setInterval(() => void refresh(), 1_000);
})();
