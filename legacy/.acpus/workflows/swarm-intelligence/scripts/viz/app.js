// app.js — live swarm-intelligence blackboard viewer.
// Loads a snapshot from /api/snapshot (live mode) or ./snapshot.json (static),
// subscribes to /api/stream for SSE pushes, and renders four views over the
// shared blackboard model.

const ROLE_KEYS = ["chal", "build", "synth", "emp"];
const ROLE_LONG = {
  chal: "challenger",
  build: "builder",
  synth: "synthesizer",
  emp: "empiricist",
};
const ROLE_LABEL = {
  chal: "Challenger",
  build: "Builder",
  synth: "Synthesizer",
  emp: "Empiricist",
};
const TYPE_AFFINITY = { objection: "chal", question: "chal", proposal: "build", evidence: "emp", claim: "synth" };

const STATE = {
  data: null,
  view: "chronicle",
  selectedRound: null,
  roundPinned: false,
  selectedContrib: null,
  graphMinWeight: 1,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function fetchSnapshot() {
  if (window.SWARM_SNAPSHOT) return window.SWARM_SNAPSHOT;
  for (const src of ["./api/snapshot", "./snapshot.json"]) {
    try {
      const r = await fetch(src, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch {}
  }
  throw new Error("No snapshot source available");
}

function connectStream(onChange) {
  if (typeof EventSource === "undefined") return null;
  // Probe the endpoint first so static deployments don't spam console errors.
  return fetch("./api/stream", { method: "GET", headers: { accept: "text/event-stream" } })
    .then((r) => {
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.includes("text/event-stream")) return null;
      const es = new EventSource("./api/stream");
      es.addEventListener("change", onChange);
      return es;
    })
    .catch(() => null);
}

function setLive(on) {
  $("#live-badge").classList.toggle("is-live", on);
}

async function refresh() {
  try {
    const snap = await fetchSnapshot();
    STATE.data = snap;
    const latest = latestVisibleRound(snap);
    if (!STATE.roundPinned || STATE.selectedRound === null) {
      STATE.selectedRound = latest;
    } else {
      STATE.selectedRound = Math.min(Math.max(1, STATE.selectedRound), latest);
    }
    render();
  } catch (err) {
    console.error(err);
  }
}

// ── Render ─────────────────────────────────────────────────────────
function render() {
  const bb = STATE.data?.blackboard;
  if (!bb) return;
  renderMasthead(bb);
  renderSidebar(bb);
  if (STATE.view === "chronicle") renderChronicle(bb);
  if (STATE.view === "graph") renderGraph(bb);
  if (STATE.view === "trajectory") renderTrajectory(bb);
  if (STATE.view === "scorecard") renderScorecard(bb);
  if (STATE.selectedContrib) renderDrawer(STATE.selectedContrib);
  $("#ts-info").textContent = new Date(STATE.data.ts).toLocaleString();
  const dirShort = STATE.data.dir ? STATE.data.dir.split("/").slice(-2).join("/") : "blackboard.json";
  $("#data-src").textContent = `data: ./${dirShort}/blackboard.json`;
}

function renderMasthead(bb) {
  const topic = typeof bb.topic === "string" && bb.topic.trim() ? bb.topic.trim() : "Live Blackboard";
  $("#topic-title").textContent = topic;
  const context = typeof bb.context === "string" ? bb.context.trim() : "";
  const contextEl = $("#topic-context");
  contextEl.textContent = context;
  contextEl.hidden = context.length === 0;
  contextEl.title = context;

  $("#brief-topic-full").textContent = topic;
  $("#brief-context-full").textContent = context;
  $("#brief-context-heading").hidden = context.length === 0;
  $("#brief-context-full").hidden = context.length === 0;

  const total = bb.round || 0;
  const latest = latestVisibleRound(STATE.data);
  $("#meta-rounds").textContent = total || latest ? `${STATE.selectedRound} / ${latest}` : "—";
  const exit = bb.final?.exit_reason
    || (bb.metrics?.semantic_stop ? "consensus_reached"
        : bb.metrics?.is_saturated ? "activity_saturation"
        : "running…");
  $("#meta-exit").textContent = exit;
}

function renderSidebar(bb) {
  const totalRounds = bb.round || 0;
  const snap = STATE.data;
  const pending = hasPendingRoundOutput(snap);
  const latest = latestVisibleRound(snap);
  const pills = $("#round-pills");
  pills.innerHTML = "";
  for (let i = 1; i <= totalRounds; i++) {
    const b = document.createElement("button");
    b.textContent = i;
    if (i === STATE.selectedRound) b.classList.add("is-active");
    if (i === totalRounds) b.classList.add("is-current");
    b.onclick = () => selectRound(i);
    pills.appendChild(b);
  }
  if (pending) {
    const b = document.createElement("button");
    b.textContent = latest;
    b.title = "Pending merge";
    b.classList.add("is-pending");
    if (latest === STATE.selectedRound) b.classList.add("is-active");
    b.onclick = () => selectRound(latest);
    pills.appendChild(b);
  }

  const counts = { consensus: 0, contested: 0, active: 0, withdrawn: 0 };
  for (const c of bb.contributions || []) counts[c.status] = (counts[c.status] || 0) + 1;
  const terminal = $("#terminal-list");
  terminal.innerHTML = "";
  for (const [k, color] of [
    ["consensus", "consensus"],
    ["contested", "contested"],
    ["active", "active"],
    ["withdrawn", "withdrawn"],
  ]) {
    if (counts[k] === undefined) continue;
    terminal.insertAdjacentHTML("beforeend",
      `<li><span class="ring ${color}"></span><span class="label">${k}:</span><span class="count">${counts[k] || 0}</span></li>`);
  }

  const stop = bb.control?.stop || {};
  const votes = $("#votes-list");
  votes.innerHTML = "";
  const max = Math.max(4, ROLE_KEYS.length);
  for (const [label, key] of [
    ["ready", "ready_votes"],
    ["block", "block_votes"],
    ["contribute", "contribute_votes"],
    ["quiet", "quiet_votes"],
  ]) {
    const n = stop[key] || 0;
    let bars = "";
    for (let i = 0; i < max; i++) bars += `<i class="${i < n ? "on" : ""}"></i>`;
    votes.insertAdjacentHTML("beforeend",
      `<li><span class="label">${label}</span><span class="bar-track">${bars}</span><span class="count">${n}</span></li>`);
  }
}

// ── Chronicle ─────────────────────────────────────────────────────
function renderChronicle(bb) {
  const root = $("#view-chronicle");
  const round = STATE.selectedRound;
  const snap = STATE.data;
  const isPendingRound = round === pendingRound(bb) && hasPendingRoundOutput(snap);
  const byRole = {};
  for (const k of ROLE_KEYS) byRole[k] = [];
  for (const c of bb.contributions || []) {
    if (c.round === round) byRole[c.role]?.push(c);
  }

  const events = (bb.events || []).filter((e) => e.round === round);
  const newCount = bb.contributions?.filter((c) => c.round === round).length || 0;
  const pendingCount = isPendingRound
    ? ROLE_KEYS.reduce((n, role) => n + (pendingPacketForRole(snap, role) ? 1 : 0), 0)
    : 0;

  root.innerHTML = `
    <div class="chronicle-header">
      <h2 class="section-title">Round ${round}${isPendingRound ? " <span>pending merge</span>" : ""}</h2>
    </div>
    <div class="round-banner">
      <div class="pair"><label>New contributions</label><strong>${newCount}</strong></div>
      ${isPendingRound ? `<div class="pair pending"><label>Pending outputs</label><strong>${pendingCount}</strong></div>` : ""}
      <div class="pair"><label>Events</label><strong>${events.length}</strong></div>
      <div class="pair"><label>Quarantined</label><strong>${(bb.metrics?.quarantined_agents || []).length}</strong></div>
      <div class="pair"><label>Round activity</label><strong>${bb.metrics?.momentum_report?.round_activity ?? "—"}</strong></div>
    </div>
  `;

  for (const role of ROLE_KEYS) {
    const items = byRole[role];
    const packet = isPendingRound ? pendingPacketForRole(snap, role) : null;
    if (items.length === 0 && !packet) continue;
    const grp = document.createElement("section");
    grp.className = "role-group";
    grp.innerHTML = `<h3 class="role-heading"><span class="dot role-${role}"></span>${ROLE_LABEL[role]}</h3>`;
    if (packet) {
      const contributions = Array.isArray(packet.contributions) ? packet.contributions : [];
      if ((packet.stance === "contribute" || packet.stance === "block_stop") && contributions.length > 0) {
        contributions.forEach((contribution, index) => {
          grp.appendChild(pendingContributionCard(role, packet, contribution, index));
        });
      } else {
        grp.appendChild(pendingStanceCard(role, packet));
      }
    }
    for (const c of items) grp.appendChild(contributionCard(c));
    root.appendChild(grp);
  }

  if (events.length > 0) {
    const ev = document.createElement("section");
    ev.className = "events-block";
    ev.innerHTML = `<h3 class="micro">Events</h3>` + events.map(eventLine).join("");
    root.appendChild(ev);
  }
}

function contributionCard(c) {
  const el = document.createElement("article");
  el.className = `contribution ${c.role}`;
  el.dataset.id = c.id;
  el.innerHTML = `
    <div class="contribution-head">
      <span class="id">[${c.id}]</span>
      <span class="type-tag" style="color:var(--${{ chal: "chal", build: "build", synth: "synth", emp: "emp" }[c.role]})">${c.type.toUpperCase()}</span>
      ${confidenceBars(c.confidence)}
      <span class="status-tag ${c.status}">${c.status}</span>
    </div>
    <div class="contribution-summary">${escapeHtml(c.summary)}</div>
    ${c.rationale ? `<div class="contribution-rationale"><strong>rationale:</strong> ${escapeHtml(c.rationale)}</div>` : ""}
    ${c.references?.length ? `<div class="contribution-refs">→ references: ${c.references.map(refLink).join(" ")}</div>` : ""}
  `;
  el.addEventListener("click", () => selectContribution(c.id));
  for (const a of $$(".contribution-refs a", el)) {
    a.addEventListener("click", (e) => { e.stopPropagation(); selectContribution(a.dataset.id); });
  }
  return el;
}

function pendingContributionCard(role, packet, contribution, index) {
  const el = document.createElement("article");
  el.className = `pending-contribution ${role}`;
  const type = typeof contribution?.type === "string" ? contribution.type : "claim";
  const confidence = Number.parseInt(contribution?.confidence, 10) || 0;
  const refs = Array.isArray(contribution?.references) ? contribution.references : [];
  el.innerHTML = `
    <div class="contribution-head">
      <span class="id">[${ROLE_LONG[role]} pending ${index + 1}]</span>
      <span class="type-tag">${escapeHtml(type).toUpperCase()}</span>
      ${confidenceBars(Math.max(0, Math.min(5, confidence)))}
      <span class="pending-tag">PENDING MERGE</span>
    </div>
    <div class="contribution-summary">${escapeHtml(contribution?.summary || "Pending contribution")}</div>
    ${packet.rationale ? `<div class="contribution-rationale"><strong>rationale:</strong> ${escapeHtml(packet.rationale)}</div>` : ""}
    ${refs.length ? `<div class="contribution-refs pending-refs">→ references: ${refs.map((ref) => `<span>${escapeHtml(ref)}</span>`).join(" ")}</div>` : ""}
  `;
  return el;
}

function pendingStanceCard(role, packet) {
  const el = document.createElement("article");
  el.className = `pending-contribution pending-stance ${role}`;
  const vote = packet?.stop_vote && typeof packet.stop_vote === "object" ? packet.stop_vote : {};
  const voteParts = [
    vote.vote ? `vote=${vote.vote}` : "",
    vote.confidence ? `confidence=${vote.confidence}` : "",
    vote.semantic_terminal_state ? `terminal=${vote.semantic_terminal_state}` : "",
    Array.isArray(vote.unresolved_refs) && vote.unresolved_refs.length ? `unresolved=${vote.unresolved_refs.join(", ")}` : "",
  ].filter(Boolean);
  const reason = typeof vote.reason === "string" ? vote.reason : "";
  const rationale = typeof packet?.rationale === "string" ? packet.rationale : "";
  el.innerHTML = `
    <div class="contribution-head">
      <span class="id">[${ROLE_LONG[role]} pending]</span>
      <span class="type-tag">${escapeHtml(packet?.stance || "packet").toUpperCase()}</span>
      <span class="pending-tag">PENDING MERGE</span>
    </div>
    <div class="pending-body">${escapeHtml(voteParts.join(" · ") || "Output received; waiting for merge.")}</div>
    ${reason ? `<div class="contribution-rationale"><strong>stop vote:</strong> ${escapeHtml(reason)}</div>` : ""}
    ${rationale ? `<div class="contribution-rationale"><strong>rationale:</strong> ${escapeHtml(rationale)}</div>` : ""}
  `;
  return el;
}

function confidenceBars(n) {
  let html = `<span class="confidence-bars">`;
  for (let i = 1; i <= 5; i++) html += `<i class="${i <= n ? "on" : ""}"></i>`;
  html += `</span>`;
  return html;
}

function refLink(id) {
  return `<a data-id="${escapeHtml(id)}">${escapeHtml(id)}</a>`;
}

function eventLine(e) {
  const main = Object.entries(e)
    .filter(([k]) => !["round", "type"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ");
  return `<div class="event-line"><span>r${e.round}</span><span class="ev-type">${e.type}</span><span>${escapeHtml(main)}</span></div>`;
}

function selectRound(round) {
  STATE.selectedRound = round;
  STATE.roundPinned = true;
  render();
}

function pendingRound(bb) {
  return (bb?.round || 0) + 1;
}

function hasPendingRoundOutput(snapshot) {
  return ROLE_KEYS.some((role) => pendingPacketForRole(snapshot, role));
}

function pendingPacketForRole(snapshot, role) {
  const longRole = ROLE_LONG[role] || role;
  const packet = snapshot?.rounds?.[longRole];
  const blackboardMtime = snapshot?.mtimes?.blackboard || 0;
  const packetMtime = snapshot?.mtimes?.rounds?.[longRole] || 0;
  if (blackboardMtime && packetMtime && packetMtime <= blackboardMtime) return null;
  if (blackboardMtime && packetMtime && (!packet || typeof packet !== "object" || Array.isArray(packet))) {
    return { stance: "waiting" };
  }
  return packet && typeof packet === "object" && !Array.isArray(packet) ? packet : null;
}

function latestVisibleRound(snapshot) {
  const bb = snapshot?.blackboard || {};
  return hasPendingRoundOutput(snapshot) ? pendingRound(bb) : Math.max(1, bb.round || 1);
}

// ── Graph ─────────────────────────────────────────────────────────
function renderGraph(bb) {
  const svg = $("#graph-svg");
  svg.innerHTML = "";
  const visibleRound = STATE.selectedRound || bb.round;
  const nodes = (bb.contributions || []).filter((c) => c.round <= visibleRound);
  const rounds = [...new Set(nodes.map((n) => n.round))].sort((a, b) => a - b);
  const colW = 170;
  const labelW = 150;
  const left = 220;
  const top = 72;
  const laneHeights = computeLaneHeights(nodes, rounds);
  const laneY = {};
  let y = top;
  for (const role of ROLE_KEYS) {
    laneY[role] = y;
    y += laneHeights[role];
  }
  const W = Math.max(900, left + Math.max(1, rounds.length) * colW + 48);
  const H = y + 58;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.style.minWidth = `${W}px`;
  svg.style.height = `${H}px`;
  svg.onclick = (e) => {
    if (e.target.closest?.(".gnode")) return;
    if (!STATE.selectedContrib) return;
    STATE.selectedContrib = null;
    $("#drawer").classList.add("is-collapsed");
    renderGraph(bb);
  };

  const minW = STATE.graphMinWeight;
  const byId = new Map(nodes.map((c) => [c.id, c]));
  const edges = [];
  for (const c of nodes) {
    for (const ref of c.references || []) {
      if (!byId.has(ref)) continue;
      if (c.confidence < minW) continue;
      edges.push({ from: c.id, to: ref, type: c.type, weight: c.confidence });
    }
  }
  const selected = STATE.selectedContrib;
  const highlighted = new Set(selected ? [selected] : []);
  for (const e of edges) {
    if (e.from === selected || e.to === selected) {
      highlighted.add(e.from);
      highlighted.add(e.to);
    }
  }

  const layout = layoutSwimlane(nodes, rounds, left, colW, laneY, laneHeights);

  for (const [i, role] of ROLE_KEYS.entries()) {
    const y = laneY[role];
    const laneH = laneHeights[role];
    svg.insertAdjacentHTML("beforeend", `
      <rect class="glane" x="0" y="${y}" width="${W}" height="${laneH}"></rect>
      <text class="glane-label" x="22" y="${y + laneH / 2 + 4}">${ROLE_LABEL[role]}</text>
    `);
  }
  svg.insertAdjacentHTML("beforeend",
    `<line class="glane-divider" x1="${labelW}" y1="${top}" x2="${labelW}" y2="${H - 58}"></line>`);
  for (const [i, round] of rounds.entries()) {
    const x = left + i * colW;
    const inRound = nodes.filter((n) => n.round === round);
    const consensus = inRound.filter((n) => n.status === "consensus").length;
    const contested = inRound.filter((n) => n.status === "contested").length;
    svg.insertAdjacentHTML("beforeend", `
      <line class="ground-line" x1="${x}" y1="${top - 26}" x2="${x}" y2="${H - 34}"></line>
      <text class="ground-label" x="${x}" y="${top - 42}">Round ${round}</text>
      <text class="ground-meta" x="${x}" y="${top - 24}">${inRound.length} new · ${consensus} consensus · ${contested} contested</text>
    `);
  }

  for (const e of edges) {
    const a = layout[e.from], b = layout[e.to];
    if (!a || !b) continue;
    const active = selected && (e.from === selected || e.to === selected);
    const muted = selected && !active;
    const direction = e.from === selected ? "is-outgoing" : e.to === selected ? "is-incoming" : "";
    const nodeHalfW = 42;
    const arrowPad = 7;
    const fromIsRightOfTarget = a.x > b.x;
    const sx = a.x + (fromIsRightOfTarget ? -nodeHalfW - arrowPad : nodeHalfW + arrowPad);
    const sy = a.y;
    const tx = b.x + (fromIsRightOfTarget ? nodeHalfW + arrowPad : -nodeHalfW - arrowPad);
    const ty = b.y;
    const dx = Math.max(36, Math.abs(tx - sx) * 0.42);
    const curveDir = fromIsRightOfTarget ? -1 : 1;
    const d = `M ${sx} ${sy} C ${sx + curveDir * dx} ${sy}, ${tx - curveDir * dx} ${ty}, ${tx} ${ty}`;
    svg.insertAdjacentHTML("beforeend",
      `<path class="gedge ${e.type} ${active ? "is-active" : ""} ${direction} ${muted ? "is-muted" : ""}" d="${d}"></path>`);
    if (active) {
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      svg.insertAdjacentHTML("beforeend", `<text class="gedge-label" x="${mx}" y="${my - 5}">${e.weight}</text>`);
    }
  }

  for (const c of nodes) {
    const p = layout[c.id];
    if (!p) continue;
    const dim = selected && !highlighted.has(c.id);
    const related = selected && highlighted.has(c.id) && c.id !== selected;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", `gnode ${dim ? "is-dim" : ""} ${related ? "is-related" : ""} ${c.id === selected ? "is-selected" : ""}`);
    g.setAttribute("transform", `translate(${p.x}, ${p.y})`);
    g.style.cursor = "pointer";
    g.addEventListener("click", () => selectContribution(c.id));
    g.innerHTML = `
      <rect class="gnode-box ${c.role} ${c.status}" x="-42" y="-26" width="84" height="52" rx="6"></rect>
      <text class="gnode-label" y="-7">${c.id}</text>
      <text class="gnode-type" y="7">${c.type}</text>
      <text class="gnode-status" y="21">${c.status}</text>
    `;
    svg.appendChild(g);
  }
}

function roleColorKey(r) { return { chal: "chal", build: "build", synth: "synth", emp: "emp" }[r] || "ink"; }

function computeLaneHeights(nodes, rounds) {
  const heights = {};
  for (const role of ROLE_KEYS) {
    const maxItems = Math.max(1, ...rounds.map((r) => nodes.filter((n) => n.round === r && n.role === role).length));
    heights[role] = Math.max(126, maxItems * 66 + 28);
  }
  return heights;
}

function layoutSwimlane(nodes, rounds, left, colW, laneY, laneHeights) {
  const pos = {};
  for (const r of rounds) {
    for (const role of ROLE_KEYS) {
      const items = nodes.filter((n) => n.round === r && n.role === role);
      const x = left + rounds.indexOf(r) * colW;
      const y0 = laneY[role];
      const laneH = laneHeights[role];
      items.forEach((n, i) => {
        const step = laneH / (items.length + 1);
        pos[n.id] = { x, y: y0 + step * (i + 1) };
      });
    }
  }
  return pos;
}

// ── Trajectory ────────────────────────────────────────────────────
function renderTrajectory(bb) {
  const root = $("#view-trajectory .traj-grid");
  if (!root) return;
  const history = bb.history || [];
  const charts = [
    { title: "New contributions per round", key: "new_contributions_count" },
    { title: "Cognitive activity", key: "cognitive_activity" },
    { title: "Ready votes (towards stop)", key: "ready_votes" },
    { title: "Quarantined agents", key: "quarantined_count" },
  ];
  root.innerHTML = "";
  for (const c of charts) {
    const card = document.createElement("div");
    card.className = "traj-card";
    const latest = history.length > 0 ? history[history.length - 1][c.key] ?? 0 : 0;
    card.innerHTML = `<h3>${c.title}</h3><div class="num">${latest}</div>${lineChart(history.map((h) => h[c.key] ?? 0))}`;
    root.appendChild(card);
  }
  const confCard = document.createElement("div");
  confCard.className = "traj-card";
  confCard.style.gridColumn = "1 / -1";
  confCard.innerHTML = `<h3>Status mix over rounds</h3>${statusMixChart(bb)}`;
  root.appendChild(confCard);
}

function lineChart(values) {
  if (values.length === 0) return `<svg viewBox="0 0 320 100"></svg>`;
  const W = 320, H = 100, pad = 12;
  const max = Math.max(1, ...values);
  const xs = (i) => pad + (i / Math.max(1, values.length - 1)) * (W - pad * 2);
  const ys = (v) => H - pad - (v / max) * (H - pad * 2);
  let path = "";
  values.forEach((v, i) => { path += (i === 0 ? "M " : " L ") + xs(i) + " " + ys(v); });
  const pts = values.map((v, i) => `<circle cx="${xs(i)}" cy="${ys(v)}" r="3" fill="var(--ink)"></circle>`).join("");
  const axis = `<line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="var(--rule)"></line>`;
  return `<svg viewBox="0 0 ${W} ${H}">${axis}<path d="${path}" stroke="var(--ink)" stroke-width="1.5" fill="none"></path>${pts}</svg>`;
}

function statusMixChart(bb) {
  const rounds = (bb.history || []).map((h) => h.round);
  if (rounds.length === 0) return `<svg viewBox="0 0 600 160"></svg>`;
  // For each round, count contributions of each status that existed by that round (status frozen at final state)
  const W = 600, H = 160, pad = 24;
  const byRound = {};
  for (const r of rounds) byRound[r] = { active: 0, contested: 0, consensus: 0, withdrawn: 0 };
  for (const c of bb.contributions || []) {
    if (!byRound[c.round]) byRound[c.round] = { active: 0, contested: 0, consensus: 0, withdrawn: 0 };
    byRound[c.round][c.status] = (byRound[c.round][c.status] || 0) + 1;
  }
  const max = Math.max(1, ...rounds.map((r) => Object.values(byRound[r]).reduce((s, v) => s + v, 0)));
  const cw = (W - pad * 2) / rounds.length;
  const colors = { active: "var(--active-ring)", contested: "var(--contested)", consensus: "var(--consensus)", withdrawn: "var(--withdrawn)" };
  let bars = "";
  rounds.forEach((r, i) => {
    const x0 = pad + cw * i + 4;
    const bw = cw - 8;
    let y = H - pad;
    for (const status of ["consensus", "active", "contested", "withdrawn"]) {
      const v = byRound[r][status] || 0;
      const h = (v / max) * (H - pad * 2);
      if (h > 0) {
        bars += `<rect x="${x0}" y="${y - h}" width="${bw}" height="${h}" fill="${colors[status]}" opacity="0.85"></rect>`;
        y -= h;
      }
    }
    bars += `<text x="${x0 + bw / 2}" y="${H - 6}" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--ink-3)">R${r}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}">${bars}</svg>`;
}

// ── Scorecard ─────────────────────────────────────────────────────
function renderScorecard(bb) {
  const root = $("#view-scorecard");
  const f = bb.final || {};
  const m = bb.metrics || {};
  const cells = [
    { l: "Rounds completed", v: f.rounds_completed ?? bb.round ?? 0 },
    { l: "Contributions", v: f.total_contributions ?? bb.contributions?.length ?? 0 },
    { l: "Consensus claims", v: f.consensus_count ?? (bb.contributions?.filter((c) => c.status === "consensus").length || 0) },
    { l: "Quarantined", v: f.quarantined_count ?? (m.quarantined_agents?.length || 0) },
    { l: "Ready votes", v: f.ready_votes ?? bb.control?.stop?.ready_votes ?? 0 },
    { l: "Block votes", v: f.block_votes ?? bb.control?.stop?.block_votes ?? 0 },
    { l: "Contribute votes", v: f.contribute_votes ?? bb.control?.stop?.contribute_votes ?? 0 },
    { l: "Quiet votes", v: f.quiet_votes ?? bb.control?.stop?.quiet_votes ?? 0 },
  ];
  const exit = { l: "Exit reason", v: f.exit_reason ?? "running…", cls: "exit" };
  const term = { l: "Terminal state", v: f.semantic_terminal_state ?? "—", cls: "exit" };
  const grid = [exit, term, ...cells]
    .map((c) => `<div class="cell ${c.cls || ""}"><label>${c.l}</label><span class="big">${c.v}</span></div>`)
    .join("");

  let md = "";
  if (STATE.data.summary) {
    md = `<div class="markdown-summary">${renderMarkdown(STATE.data.summary)}</div>`;
  }
  root.innerHTML = `<div class="scorecard-grid">${grid}</div>${md}`;
}

// ── Drawer ────────────────────────────────────────────────────────
function selectContribution(id) {
  STATE.selectedContrib = id;
  $("#drawer").classList.remove("is-collapsed");
  if (STATE.view === "graph" && STATE.data?.blackboard) renderGraph(STATE.data.blackboard);
  renderDrawer(id);
}

function renderDrawer(id) {
  const bb = STATE.data.blackboard;
  const c = bb.contributions?.find((x) => x.id === id);
  const body = $("#drawer-body");
  if (!c) {
    body.innerHTML = `<p class="muted">Contribution "${escapeHtml(id)}" not found.</p>`;
    return;
  }
  const events = (bb.events || []).filter((e) => e.id === id || e.from === id || e.ref === id);
  const referencedBy = (bb.contributions || []).filter((x) => (x.references || []).includes(id));
  body.innerHTML = `
    <h3 class="drawer-id">[${c.id}]</h3>
    <div class="role-line"><span class="dot role-${c.role}" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--${roleColorKey(c.role)});"></span>${ROLE_LABEL[c.role]}</div>
    <div class="pill">Round ${c.round}</div>

    <section>
      <div class="kv">
        <dt>Claim</dt><dd>${confidenceBars(c.confidence)}</dd>
      </div>
      <blockquote>${escapeHtml(c.summary)}</blockquote>
      ${c.rationale ? `<p style="font-family:var(--sans);font-size:13px;color:var(--ink-2);">${escapeHtml(c.rationale)}</p>` : ""}
    </section>

    <section>
      <h4 class="micro">Status</h4>
      <p><span class="status-tag ${c.status}">${c.status}</span></p>
    </section>

    <section>
      <h4 class="micro">References (${c.references?.length || 0})</h4>
      <div class="ref-list">${(c.references || []).map((r) => `<a data-id="${escapeHtml(r)}">${escapeHtml(r)}</a>`).join("") || `<span class="muted">—</span>`}</div>
    </section>

    <section>
      <h4 class="micro">Referenced by (${referencedBy.length})</h4>
      <div class="ref-list">${referencedBy.map((r) => `<a data-id="${escapeHtml(r.id)}">${escapeHtml(r.id)} <span style="color:var(--ink-3);">(${r.type})</span></a>`).join("") || `<span class="muted">—</span>`}</div>
    </section>

    <section>
      <h4 class="micro">Event history</h4>
      <div class="event-timeline">
        ${events.map((e) => `
          <div class="row">
            <span class="ts">R${e.round}</span>
            <span><span class="event-type ${e.type}">${e.type}</span>${eventMeta(e)}</span>
          </div>`).join("") || `<span class="muted">No events yet.</span>`}
      </div>
    </section>
  `;
  for (const a of $$(".ref-list a", body)) {
    a.addEventListener("click", () => selectContribution(a.dataset.id));
  }
}

function eventMeta(e) {
  const meta = Object.entries(e)
    .filter(([k]) => !["round", "type", "id"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("  ");
  return meta ? `<span style="color:var(--ink-3);">${escapeHtml(meta)}</span>` : "";
}

// ── Markdown (markdown-it) ────────────────────────────────────────
const markdown = window.markdownit
  ? window.markdownit({ html: false, linkify: true, typographer: true, breaks: false })
  : null;

function renderMarkdown(md) {
  if (!markdown) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<pre>${esc(md)}</pre>`;
  }
  return markdown.render(md || "");
}

// ── Helpers ───────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Wire up controls ──────────────────────────────────────────────
function setView(v) {
  STATE.view = v;
  for (const t of $$(".tab")) t.classList.toggle("is-active", t.dataset.tab === v);
  for (const view of $$(".view")) view.classList.toggle("is-active", view.id === `view-${v}`);
  if (location.hash !== `#${v}`) history.replaceState(null, "", `#${v}`);
  render();
}

function init() {
  if (window.lucide) window.lucide.createIcons();
  const tabs = ["chronicle", "graph", "trajectory", "scorecard"];
  const initial = location.hash.replace(/^#/, "");
  if (tabs.includes(initial)) STATE.view = initial;
  for (const t of $$(".tab")) {
    t.classList.toggle("is-active", t.dataset.tab === STATE.view);
    t.addEventListener("click", () => setView(t.dataset.tab));
  }
  for (const view of $$(".view")) view.classList.toggle("is-active", view.id === `view-${STATE.view}`);
  window.addEventListener("hashchange", () => {
    const v = location.hash.replace(/^#/, "");
    if (tabs.includes(v)) setView(v);
  });
  $("#drawer-close").addEventListener("click", () => {
    STATE.selectedContrib = null;
    $("#drawer").classList.add("is-collapsed");
  });
  $("#help-open").addEventListener("click", () => $("#help-dialog").showModal());
  $("#help-close").addEventListener("click", () => $("#help-dialog").close());
  $("#help-dialog").addEventListener("click", (e) => {
    if (e.target === $("#help-dialog")) $("#help-dialog").close();
  });
  $("#graph-min-weight").addEventListener("change", (e) => {
    STATE.graphMinWeight = Number(e.target.value);
    if (STATE.view === "graph") renderGraph(STATE.data.blackboard);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#help-dialog").open) return;
    if (e.key === "Escape") { STATE.selectedContrib = null; $("#drawer").classList.add("is-collapsed"); return; }
    if (e.key === "ArrowLeft" && STATE.selectedRound > 1) { selectRound(STATE.selectedRound - 1); return; }
    if (e.key === "ArrowRight" && STATE.data && STATE.selectedRound < latestVisibleRound(STATE.data)) {
      selectRound(STATE.selectedRound + 1); return;
    }
    if (["1", "2", "3", "4"].includes(e.key)) {
      setView(["chronicle", "graph", "trajectory", "scorecard"][Number(e.key) - 1]);
    }
  });
}

init();
refresh();
let liveES = null;
connectStream(() => { setLive(true); refresh(); }).then((es) => {
  liveES = es;
  if (es) setLive(true);
});
// poll fallback every 2s when no SSE
setInterval(() => { if (!liveES) refresh(); }, 2000);
