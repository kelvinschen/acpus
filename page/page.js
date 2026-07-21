/* ============================================================
   Acpus — "Paper Relay"
   One instrument: task → workflow.ts → check → lowered graph →
   a durable run the visitor drives (pause, retry, signal, ending).
   Scripted simulation of the real CLI & runtime semantics.
   ============================================================ */

"use strict";

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPEED = REDUCED ? 2.5 : 1.5; // run-timeline pace
/* real acpus shapes: <timestamp><20 hex> run id, frame#scope/leaf~digest nodeKey */
const RUN_ID = "20260717143052A91F3E7C42D08B6E5F";
const RUN_DIR = `.acpus/.local/runs/${RUN_ID}`;
const RETRY_KEY = "verify_claims#1/verify~8d2b4f6a0c18";

const $ = (sel) => document.querySelector(sel);
const AGENTS = Object.freeze(
  [...document.querySelectorAll(".roster li:not(.roster-more)")].map((item) => item.textContent.trim())
);

/* ------------------------------------------------------------
   hero tagline — paper-cut word landing
   ------------------------------------------------------------ */

const heroTagline = $(".hero-tagline");
const heroArt = $(".hero-art");
const heroTaglineTrack = $("#heroTaglineTrack");
const heroTaglineMeasure = $("#heroTaglineMeasure");
const HERO_PHRASE_TEXT = "agents orchestrate agents";
const HERO_INTRO_MS = 980;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sizeHeroPhrase() {
  heroTaglineMeasure.textContent = HERO_PHRASE_TEXT;
  const baseFontSize = parseFloat(getComputedStyle(heroTagline).fontSize);
  const measuredWidth = heroTaglineMeasure.getBoundingClientRect().width;
  const scale = Math.min(1, heroTagline.clientWidth / measuredWidth);
  const fontSize = baseFontSize * scale;
  heroTaglineTrack.style.fontSize = `${fontSize}px`;
  heroTaglineTrack.style.width = `${Math.ceil(measuredWidth * scale)}px`;
}

let heroResizeFrame;
window.addEventListener("resize", () => {
  cancelAnimationFrame(heroResizeFrame);
  heroResizeFrame = requestAnimationFrame(sizeHeroPhrase);
});

async function animateHeroTagline() {
  const introElapsed = wait(HERO_INTRO_MS);
  const fontReady = document.fonts?.load("900 1em Outfit", HERO_PHRASE_TEXT) ?? Promise.resolve();
  await heroArt.decode?.().catch(() => {});
  heroArt.classList.add("is-entering");
  await Promise.all([fontReady, introElapsed]);
  sizeHeroPhrase();
  heroTagline.classList.add("is-entering");
  heroTagline.classList.remove("is-waiting");
}

/* ------------------------------------------------------------
   sim clock — pausable, holdable (durable gate), event queue
   ------------------------------------------------------------ */

const clock = {
  t: 0,
  last: 0,
  running: false,
  paused: false,
  held: false,
  queue: [],
  tokens: [],
};

function at(ms, fn) {
  clock.queue.push({ ms, fn });
  clock.queue.sort((a, b) => a.ms - b.ms);
}

function later(ms, fn) {
  at(clock.t + ms, fn);
}

function clockStart() {
  clock.running = true;
  clock.last = performance.now();
  requestAnimationFrame(clockLoop);
}

function clockLoop(now) {
  if (!clock.running) return;
  const dt = Math.min(120, now - clock.last);
  clock.last = now;
  if (!clock.paused && !clock.held) {
    clock.t += dt * SPEED;
    while (clock.queue.length && clock.queue[0].ms <= clock.t) {
      clock.queue.shift().fn();
    }
    stepTokens(dt);
  }
  requestAnimationFrame(clockLoop);
}

/* ------------------------------------------------------------
   terminal echo
   ------------------------------------------------------------ */

const termEl = $("#term");

function termLine(html, cls) {
  const line = document.createElement("span");
  line.className = "tline" + (cls ? " " + cls : "");
  line.innerHTML = html;
  termEl.appendChild(line);
  termEl.scrollTop = termEl.scrollHeight;
  return line;
}

function termCmd(text, done) {
  const line = termLine("", "t-cmd");
  if (REDUCED) {
    line.textContent = text;
    termEl.scrollTop = termEl.scrollHeight;
    if (done) done();
    return;
  }
  let i = 0;
  const iv = setInterval(() => {
    i += 1;
    line.textContent = text.slice(0, i);
    termEl.scrollTop = termEl.scrollHeight;
    if (i >= text.length) {
      clearInterval(iv);
      if (done) done();
    }
  }, 13);
}

/* ------------------------------------------------------------
   run status line
   ------------------------------------------------------------ */

const statusEl = $("#runStatus");

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "stage-live" + (cls ? " " + cls : "");
}

/* ------------------------------------------------------------
   workflow.ts source — highlighted lines, signature mapping
   ------------------------------------------------------------ */

const CODE_LINES = [
  { html: `<span class="tok-k">import</span> { defineWorkflow, z } <span class="tok-k">from</span> <span class="tok-s">"acpus/core"</span>;` },
  { html: `<span class="tok-k">import</span> { md } <span class="tok-k">from</span> <span class="tok-s">"acpus/expression"</span>;` },
  { html: `` },
  { html: `<span class="tok-k">export default</span> <span class="tok-t">defineWorkflow</span>({` },
  { html: `  name: <span class="tok-s">"fact-check"</span>,` },
  { html: `  inputSchema: z.object({ article: z.string() }),` },
  { html: `  agents: {` },
  { html: `    extractor: { use: <span class="tok-s">"claude"</span> },` },
  { html: `    verifier: { use: <span class="tok-s">"pi"</span> },` },
  { html: `    redteam: { use: <span class="tok-s">"codex"</span> },` },
  { html: `  },` },
  { html: `}).build(({ input, agents, meta, step }) <span class="tok-k">=&gt;</span> {` },
  { html: `  <span class="tok-k">const</span> claims = <span class="tok-t">step</span>(<span class="tok-s">"extract_claims"</span>).<span class="tok-t">agent</span>({`, sig: "extract" },
  { html: `    agent: agents.extractor,` },
  { html: `    cwd: meta.workspaceDir,` },
  { html: `    outputSchema: z.array(z.string()).length(<span class="tok-n">4</span>),` },
  { html: `    prompt: <span class="tok-t">md</span>\`` },
  { html: `      Extract exactly four important technical claims from this article:` },
  { html: `      \${input.article}` },
  { html: `      Return only the four concise claims requested by the output schema.` },
  { html: `    \`,` },
  { html: `  });` },
  { html: `` },
  { html: `  <span class="tok-k">const</span> verdicts = <span class="tok-t">step</span>(<span class="tok-s">"verify_claims"</span>).<span class="tok-t">fanout</span>({`, sig: "verify" },
  { html: `    over: claims.output,` },
  { html: `    maxConcurrency: <span class="tok-n">3</span>,` },
  { html: `    do({ item }) {` },
  { html: `      <span class="tok-k">return</span> <span class="tok-t">step</span>(<span class="tok-s">"verify"</span>).<span class="tok-t">agent</span>({` },
  { html: `        agent: agents.verifier,` },
  { html: `        cwd: meta.workspaceDir,` },
  { html: `        prompt: <span class="tok-t">md</span>\`Check \${item} against project code and primary sources. Return a concise cited verdict.\`,` },
  { html: `      }).output;` },
  { html: `    },` },
  { html: `  });` },
  { html: `` },
  { html: `  <span class="tok-k">const</span> attack = <span class="tok-t">step</span>(<span class="tok-s">"red_team"</span>).<span class="tok-t">agent</span>({`, sig: "redteam" },
  { html: `    agent: agents.redteam,` },
  { html: `    cwd: meta.workspaceDir,` },
  { html: `    prompt: <span class="tok-t">md</span>\`Attack weak findings in \${verdicts.output}. Return only substantial objections and concessions.\`,` },
  { html: `  });` },
  { html: `` },
  { html: `  <span class="tok-k">const</span> gate = <span class="tok-t">step</span>(<span class="tok-s">"publish_gate"</span>).<span class="tok-t">signal</span>({`, sig: "gate" },
  { html: `    outputSchema: z.object({ approved: z.literal(<span class="tok-k">true</span>) }),` },
  { html: `    prompt: <span class="tok-t">md</span>\`Approve publishing the cited report from \${verdicts.output} after \${attack.output}?\`,` },
  { html: `  });` },
  { html: `` },
  { html: `  <span class="tok-k">const</span> report = <span class="tok-t">step</span>(<span class="tok-s">"write_report"</span>).<span class="tok-t">task</span>({`, sig: "report" },
  { html: `    input: {` },
  { html: `      verdicts: verdicts.output,` },
  { html: `      attack: attack.output,` },
  { html: `      approved: gate.output.approved,` },
  { html: `    },` },
  { html: `    exec: <span class="tok-k">async</span> ({ input, artifact }) <span class="tok-k">=&gt;</span> {` },
  { html: `      <span class="tok-k">const</span> markdown = [` },
  { html: `        <span class="tok-s">"# Fact-check report"</span>,` },
  { html: `        ...input.verdicts.map((verdict, index) <span class="tok-k">=&gt;</span> \`\\n## Claim \${index + 1}\\n\${verdict}\`),` },
  { html: `        \`\\n## Red-team review\\n\${input.attack}\`,` },
  { html: `      ].join(<span class="tok-s">"\\n"</span>);` },
  { html: `      <span class="tok-k">return</span> {` },
  { html: `        report: <span class="tok-k">await</span> artifact.write(<span class="tok-s">"fact-check-report.md"</span>, markdown, { mediaType: <span class="tok-s">"text/markdown"</span> }),` },
  { html: `      };` },
  { html: `    },` },
  { html: `  });` },
  { html: `` },
  { html: `  <span class="tok-k">return</span> report.output;` },
  { html: `});` },
];

/* ------------------------------------------------------------
   graph model — design space 940 × 400
   ------------------------------------------------------------ */

const GRAPH_W = 940;
const GRAPH_H = 400;
const LANE_Y = 200;

const NODES = {
  extract: { id: "extract_claims", agent: "claude · agent", x: 8, y: 165, w: 140, h: 70 },
  verify: { id: "verify_claims", agent: "pi · fanout × 4", x: 185, y: 165, w: 216, h: 70, frame: { y: 88, h: 224 } },
  redteam: { id: "red_team", agent: "codex · agent", x: 438, y: 165, w: 140, h: 70 },
  gate: { id: "publish_gate", agent: "signal · gate", x: 615, y: 165, w: 140, h: 70 },
  report: { id: "write_report", agent: "task · node", x: 792, y: 165, w: 140, h: 70 },
};

const GATE_TIP = { left: 532, top: 10, width: 306 };
const GATE_CX = 685; // gate node center-x
const GATE_TOP = 165;

/* the edge that connects right before each node appears */
const EDGE_BEFORE = { verify: "e1", redteam: "e2", gate: "e3", report: "e4" };

const ORDER = ["extract", "verify", "redteam", "gate", "report"];

const graphEl = $("#graph");
const graphCol = $("#graphCol");
const graphViewport = $("#graphViewport");
const graphZoom = $("#graphZoom");
const graphHint = $("#graphHint");
let svgEdges = null;
let edgeEls = {};
let nodeEls = {};
let itemEls = [];
let verifyExpanded = false;

/* fit the 940×400 design space into the available area — scale down
   when needed; on narrow screens keep it readable and allow panning */
function fitGraph(estimatedWidth) {
  if (graphCol.hidden) return;
  const w = estimatedWidth || graphViewport.clientWidth;
  const h = graphViewport.clientHeight || stageBody.clientHeight;
  const inSplit = stageBody.classList.contains("is-split");
  const pan = w < 700 && !inSplit; // narrow full-width: keep readable, allow panning
  const s = pan ? Math.min(1, h / GRAPH_H) : Math.min(1.12, w / GRAPH_W, h / GRAPH_H);
  const canPan = pan && s * GRAPH_W > w + 2;
  graphViewport.classList.toggle("can-pan", canPan);
  graphHint.hidden = !canPan;
  graphZoom.style.width = GRAPH_W * s + "px";
  graphZoom.style.height = GRAPH_H * s + "px";
  graphEl.style.transform = `scale(${s})`;
}

window.addEventListener("resize", () => fitGraph());

function edgePath(x1, y1, x2, y2) {
  const dx = Math.max(28, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function makeEdge(name, d, cls) {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  p.setAttribute("class", "edge" + (cls ? " " + cls : ""));
  svgEdges.appendChild(p);
  edgeEls[name] = p;
  return p;
}

function renderBaseGraph() {
  graphEl.innerHTML = "";
  edgeEls = {};
  nodeEls = {};
  itemEls = [];
  verifyExpanded = false;

  svgEdges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgEdges.setAttribute("class", "edges");
  svgEdges.setAttribute("viewBox", `0 0 ${GRAPH_W} ${GRAPH_H}`);
  svgEdges.setAttribute("aria-hidden", "true");
  graphEl.appendChild(svgEdges);

  // static edges between neighbouring columns — uniform 37px gaps
  makeEdge("e1", edgePath(148, LANE_Y, 185, LANE_Y));
  makeEdge("e2", edgePath(401, LANE_Y, 438, LANE_Y));
  makeEdge("e3", edgePath(578, LANE_Y, 615, LANE_Y));
  makeEdge("e4", edgePath(755, LANE_Y, 792, LANE_Y));
  // the signal edge ties the gate tooltip to the gate node — hidden until then
  makeEdge("sig", `M ${GATE_CX} 130 L ${GATE_CX} ${GATE_TOP}`, "is-signal");

  for (const key of ORDER) {
    const n = NODES[key];
    const el = document.createElement("div");
    el.className = "node";
    el.dataset.node = key;
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    el.style.width = n.w + "px";
    el.style.height = n.h + "px";
    el.style.visibility = "hidden";
    el.innerHTML = `
      <div class="n-id"><span class="dot"></span><span>${n.id}</span></div>
      <div class="n-agent">${n.agent}</div>
      <div class="n-state">queued</div>`;
    graphEl.appendChild(el);
    nodeEls[key] = el;
  }

  const tip = document.createElement("div");
  tip.className = "gate-tip-shell";
  tip.id = "gateTip";
  tip.hidden = true;
  tip.style.left = GATE_TIP.left + "px";
  tip.style.top = GATE_TIP.top + "px";
  tip.style.width = GATE_TIP.width + "px";
  tip.innerHTML = `
    <div class="gate-tip-panel">
      <span class="gt-label"><strong>publish_gate</strong> awaits a signal — the run holds at a durable gate.</span>
      <button class="btn btn-signal" id="approveBtn" type="button">Approve</button>
    </div>`;
  graphEl.appendChild(tip);
  tip.querySelector("#approveBtn").addEventListener("click", fireSignal);

  edgeEls.e1.style.opacity = "0";
  edgeEls.e2.style.opacity = "0";
  edgeEls.e3.style.opacity = "0";
  edgeEls.e4.style.opacity = "0";
  edgeEls.sig.style.opacity = "0";
}

function setNodeState(key, state, label) {
  const el = nodeEls[key];
  el.classList.remove("is-running", "is-complete", "is-failed", "is-awaiting");
  if (state !== "queued") el.classList.add("is-" + state);
  const stateEl = el.querySelector(".n-state");
  if (stateEl) stateEl.textContent = label || state;
  if (state === "running" || state === "awaiting") panTo(key);
}

/* on narrow screens the graph pans instead of shrinking — keep the
   active node inside the visible slice */
function panTo(key) {
  if (!graphViewport.classList.contains("can-pan")) return;
  const n = NODES[key];
  const s = graphEl.getBoundingClientRect().width / GRAPH_W;
  const target = Math.max(0, n.x * s - graphViewport.clientWidth * 0.25);
  graphViewport.scrollTo({ left: target, behavior: REDUCED ? "auto" : "smooth" });
}

/* ------------------------------------------------------------
   tokens — value flow along edges (sim-clock driven)
   ------------------------------------------------------------ */

function stepTokens(dt) {
  for (let i = clock.tokens.length - 1; i >= 0; i--) {
    const tok = clock.tokens[i];
    tok.p += (dt * SPEED) / tok.dur;
    if (tok.p >= 1) {
      tok.el.remove();
      clock.tokens.splice(i, 1);
      tok.onArrive();
    } else {
      const pt = tok.path.getPointAtLength(tok.len * tok.p);
      tok.el.setAttribute("transform", `translate(${pt.x} ${pt.y}) rotate(45)`);
    }
  }
}

function sendToken(path, dur, onArrive) {
  path.classList.add("is-live");
  if (REDUCED) {
    later(90, () => {
      path.classList.remove("is-live");
      onArrive();
    });
    return;
  }
  const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  el.setAttribute("class", "token");
  el.setAttribute("x", "-4");
  el.setAttribute("y", "-4");
  el.setAttribute("width", "8");
  el.setAttribute("height", "8");
  el.setAttribute("rx", "4");
  svgEdges.appendChild(el);
  clock.tokens.push({ path, len: path.getTotalLength(), p: 0, dur, el, onArrive: () => {
    path.classList.remove("is-live");
    onArrive();
  } });
}

/* ------------------------------------------------------------
   artifact tray
   ------------------------------------------------------------ */

const trayEl = $("#artifactTray");
const trayItems = $("#trayItems");

function addArtifact(name) {
  trayEl.hidden = false;
  const chip = document.createElement("span");
  chip.className = "tray-chip";
  chip.textContent = name;
  trayItems.appendChild(chip);
}

/* ------------------------------------------------------------
   the sequence — delegate → author → check → lower → run
   ------------------------------------------------------------ */

const stageEl = $("#stage");
const stageBody = $("#stageBody");
const stageIdle = $("#stageIdle");
const codePanel = $("#codePanel");
const fileTab = $("#fileTab");
const authoringStatus = $("#authoringStatus");
const delegateBtn = $("#delegateBtn");
const delegateLabel = $("#delegateLabel");
const taskBtn = $("#taskBtn");
const skipBtn = $("#skipBtn");
const pauseBtn = $("#pauseBtn");
const resumeBtn = $("#resumeBtn");
const replayBtn = $("#replayBtn");
const completePlate = $("#completePlate");
const stageShell = $(".stage-shell");
const workbenchPage = $("#workbench");
const heroIntro = $(".hero-intro");
const taskCard = $("#taskCard");
const instrumentEl = $("#instrument");

let lineEls = [];
let phase = "idle"; // idle | authoring | checking | lowering | running | done
let hasDelegated = false;
let workbenchTransitionTimer;
let retryKeyEl = null;
let retryFired = false;
let approved = false;

function buildCodePanel() {
  codePanel.innerHTML = "";
  lineEls = CODE_LINES.map((l) => {
    const el = document.createElement("span");
    el.className = "cl is-pending";
    el.innerHTML = l.html || "&nbsp;";
    if (l.sig) el.dataset.sig = l.sig;
    codePanel.appendChild(el);
    return el;
  });
}

function setAuthoring(text) {
  authoringStatus.hidden = false;
  authoringStatus.textContent = text;
}

function authorCode(done) {
  phase = "authoring";
  stageIdle.hidden = true;
  fileTab.hidden = false;
  skipBtn.hidden = false;
  codePanel.hidden = false;
  buildCodePanel();

  const beats = ["reading the task…", "designing the graph…", "writing workflow.ts…"];
  let bi = 0;
  setAuthoring(beats[0]);
  const beatIv = setInterval(() => {
    bi = (bi + 1) % beats.length;
    if (phase === "authoring") setAuthoring(beats[bi]);
  }, 1400);

  if (REDUCED) {
    lineEls.forEach((el) => el.classList.remove("is-pending"));
    clearInterval(beatIv);
    done();
    return;
  }

  let i = 0;
  const caret = document.createElement("span");
  caret.className = "caret";
  function typeNext() {
    if (phase !== "authoring") { clearInterval(beatIv); return; } // skipped
    if (i >= lineEls.length) {
      clearInterval(beatIv);
      caret.remove();
      done();
      return;
    }
    const el = lineEls[i];
    el.classList.remove("is-pending");
    el.classList.add("is-fresh");
    el.appendChild(caret);
    codePanel.scrollTop = codePanel.scrollHeight;
    const isSig = Boolean(CODE_LINES[i].sig);
    i += 1;
    setTimeout(typeNext, isSig ? 300 : el.textContent.trim() === "" ? 30 : 62);
  }
  setTimeout(typeNext, 500);
}

function runCheck(done) {
  phase = "checking";
  setAuthoring("acpus workflow check…");
  termCmd("acpus workflow check workflow.ts", () => {
    const rows = [
      [`<span class="t-ok">✓</span> typescript          <span class="t-dim">0 errors</span>`, 260],
      [`<span class="t-ok">✓</span> authoring rules     <span class="t-dim">0 errors</span>`, 260],
      [`<span class="t-ok">✓</span> WorkflowIR          <span class="t-dim">0 errors · 6 static nodes</span>`, 0],
    ];
    let i = 0;
    function next() {
      if (phase !== "checking") return; // skipped
      if (i >= rows.length) {
        done();
        return;
      }
      termLine(rows[i][0]);
      const wait = rows[i][1];
      i += 1;
      setTimeout(next, REDUCED ? 0 : wait);
    }
    setTimeout(next, REDUCED ? 0 : 320);
  });
}

/* step blocks (CODE_LINES index ranges) — the unit the morph highlights */
const BLOCKS = {
  extract: [12, 21],
  verify: [23, 33],
  redteam: [35, 39],
  gate: [41, 44],
  report: [46, 62],
};

function lightBlock(key) {
  const [from, to] = BLOCKS[key];
  lineEls.forEach((el, i) => {
    el.classList.toggle("is-lit", i >= from && i <= to);
    el.classList.toggle("is-dim", !(i >= from && i <= to));
  });
  const line = lineEls[from];
  const target = codePanel.scrollTop
    + (line.getBoundingClientRect().top - codePanel.getBoundingClientRect().top)
    - codePanel.clientHeight * 0.32;
  codePanel.scrollTo({ top: target, behavior: REDUCED ? "auto" : "smooth" });
}

function clearBlocks() {
  lineEls.forEach((el) => el.classList.remove("is-lit", "is-dim"));
}

/* every step block lights up, then its node flies out of the code
   into the graph — the lowering made visible */
function lowerGraph(done) {
  phase = "lowering";
  setAuthoring("lowering to WorkflowIR…");
  setStatus("lowering — workflow.ts → frozen graph", "is-running");
  const split = stageBody.clientWidth >= 720;
  graphCol.hidden = false;

  /* nodes appear one by one; each edge draws right before its target node */
  const drawOneEdge = (name) => {
    const p = edgeEls[name];
    p.style.opacity = "";
    if (!REDUCED) p.classList.add("draw");
  };

  if (!split) {
    /* narrow stage: light each block in place, then reveal node → edge → node */
    let i = 0;
    const lightAll = () => {
      if (phase !== "lowering") return; // skipped
      if (i >= ORDER.length) {
        clearBlocks();
        stageBody.classList.add("is-graph-full");
        fitGraph(stageBody.clientWidth);
        setTimeout(() => fitGraph(), 580);
        setTimeout(() => {
          let j = 0;
          const revealNext = () => {
            if (phase !== "lowering") return;
            if (j >= ORDER.length) {
              setTimeout(done, REDUCED ? 0 : 300);
              return;
            }
            const key = ORDER[j];
            if (EDGE_BEFORE[key]) drawOneEdge(EDGE_BEFORE[key]);
            nodeEls[key].style.visibility = "visible";
            j += 1;
            setTimeout(revealNext, REDUCED ? 0 : 320);
          };
          revealNext();
        }, REDUCED ? 60 : 560);
        return;
      }
      lightBlock(ORDER[i]);
      i += 1;
      setTimeout(lightAll, REDUCED ? 0 : 460);
    };
    requestAnimationFrame(() => { fitGraph(stageBody.clientWidth); });
    setTimeout(lightAll, REDUCED ? 0 : 200);
    return;
  }

  /* split stage: code left, graph right — block lights, edge draws, node flies */
  requestAnimationFrame(() => {
    stageBody.classList.add("is-split");
    fitGraph(stageBody.clientWidth * 0.58);
    setTimeout(() => fitGraph(), 580);
  });

  let idx = 0;
  const flyNext = () => {
    if (phase !== "lowering") return; // skipped
    if (idx >= ORDER.length) {
      clearBlocks();
      setTimeout(done, REDUCED ? 0 : 320);
      return;
    }
    const key = ORDER[idx];
    lightBlock(key);
    idx += 1;
    setTimeout(() => {
      if (phase !== "lowering") return;
      const edge = EDGE_BEFORE[key];
      if (edge) drawOneEdge(edge);
      setTimeout(() => {
        if (phase !== "lowering") return;
        flyNode(key, lineEls[BLOCKS[key][0]]);
        setTimeout(flyNext, REDUCED ? 0 : 220);
      }, REDUCED ? 0 : edge ? 360 : 0);
    }, REDUCED ? 0 : 460);
  };
  // let the split land before the first block lights
  setTimeout(flyNext, REDUCED ? 0 : 620);
}

function flyNode(key, fromLineEl) {
  const node = nodeEls[key];
  if (REDUCED || !fromLineEl) {
    node.style.visibility = "visible";
    return;
  }
  const from = fromLineEl.getBoundingClientRect();
  const to = node.getBoundingClientRect();
  // the ghost must look exactly like the scaled graph node at every moment:
  // outer wrapper flies, inner full-size clone carries the graph's scale
  const s = to.width / node.offsetWidth;
  const ghost = document.createElement("div");
  ghost.style.cssText = `position:fixed;left:${from.left}px;top:${from.top}px;width:${to.width}px;height:${to.height}px;z-index:40;margin:0;`;
  const inner = node.cloneNode(true);
  inner.style.visibility = "visible";
  inner.style.left = "0";
  inner.style.top = "0";
  inner.style.transform = `scale(${s})`;
  inner.style.transformOrigin = "0 0";
  ghost.appendChild(inner);
  document.body.appendChild(ghost);
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  const anim = ghost.animate(
    [
      { transform: "translate(0, 0) scale(1.35)", opacity: 0.35 },
      { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1 },
    ],
    { duration: 460, easing: "cubic-bezier(0.22, 0.61, 0.21, 1)", fill: "forwards" }
  );
  anim.onfinish = () => {
    node.style.visibility = "visible";
    ghost.remove();
  };
}

function finishLowering() {
  authoringStatus.hidden = true;
  skipBtn.hidden = true;
  stageBody.classList.remove("is-split");
  stageBody.classList.add("is-graph-full");
  fitGraph(stageBody.clientWidth);
  setTimeout(() => {
    codePanel.hidden = true;
    fitGraph();
    startRun();
  }, REDUCED ? 60 : 260);
}

/* ------------------------------------------------------------
   the run
   ------------------------------------------------------------ */

function expandFanout(onItemsReady) {
  verifyExpanded = true;
  const n = NODES.verify;
  const el = nodeEls.verify;
  el.classList.add("fanout");
  el.style.top = n.frame.y + "px";
  el.style.height = n.frame.h + "px";
  el.innerHTML = `
    <div class="f-head">
      <span class="n-id"><span class="dot"></span><span>${n.id}</span></span>
      <span class="f-side"><span class="n-state">0/4</span></span>
    </div>
    <div class="fanout-items"></div>`;
  const itemsBox = el.querySelector(".fanout-items");
  itemEls = [1, 2, 3, 4].map((n, i) => {
    const it = document.createElement("div");
    it.className = "fitem is-queued";
    it.innerHTML = `<span class="dot"></span><span>verify[${i}]</span><span class="f-agent">pi</span><span class="f-meta">queued</span>`;
    itemsBox.appendChild(it);
    return it;
  });
  requestAnimationFrame(() => {
    itemEls.forEach((it, i) => setTimeout(() => it.classList.add("is-in"), REDUCED ? 0 : i * 110));
    setTimeout(onItemsReady, REDUCED ? 0 : 520);
  });
}

function drawFanEdges() {
  // live-measure item positions so edges land exactly on lanes
  const frame = nodeEls.verify;
  const frameLeft = parseFloat(frame.style.left);
  const frameTop = parseFloat(frame.style.top);
  edgeEls.e1.remove();
  edgeEls.e2.remove();
  itemEls.forEach((it, i) => {
    const cy = frameTop + it.offsetTop + it.offsetHeight / 2;
    const lx = frameLeft + it.offsetLeft;
    const rx = lx + it.offsetWidth;
    makeEdge("fo" + i, edgePath(148, LANE_Y, lx, cy));
    makeEdge("fi" + i, edgePath(rx, cy, 438, LANE_Y));
    if (!REDUCED) {
      edgeEls["fo" + i].classList.add("draw");
      edgeEls["fi" + i].classList.add("draw");
    }
  });
}

function setItem(i, state, meta) {
  const it = itemEls[i];
  it.classList.remove("is-queued", "is-running", "is-complete", "is-failed");
  it.classList.add("is-" + state);
  it.querySelector(".f-meta").textContent = meta;
}

let verifyDone = 0;

function bumpVerify() {
  verifyDone += 1;
  if (verifyDone < 4) setNodeState("verify", "running", `${verifyDone}/4`);
}

function startRun() {
  phase = "running";
  clock.t = 0;
  clock.queue = [];
  clock.paused = false;
  clock.held = false;
  retryFired = false;
  approved = false;
  verifyDone = 0;

  pauseBtn.hidden = false;
  resumeBtn.hidden = true;
  skipBtn.hidden = true;
  replayBtn.hidden = true;

  scheduleRun();
  if (!clock.running) clockStart();
}

function scheduleRun() {
  at(0, () => {
    setStatus("running — extract_claims", "is-running");
    termCmd(`acpus workflow run workflow.ts`, () => {
      termLine(`run <span class="t-gilt">${RUN_ID}</span> admitted <span class="t-dim">· 5 root steps · 6 static nodes · workspace-local state</span>`);
    });
  });

  /* --- extract --- */
  at(300, () => setNodeState("extract", "running", "running"));
  at(4300, () => {
    setNodeState("extract", "complete", "✓ 4 claims");
    termLine(`<span class="t-ok">✓</span> extract_claims <span class="t-dim">completed · 4 claims · 14.2s</span>`);
    sendToken(edgeEls.e1, 700, () => {
      setStatus("running — verify_claims fanout × 4", "is-running");
      setNodeState("verify", "running", "0/4");
      expandFanout(() => {
        drawFanEdges();
        [0, 1, 2].forEach((i) => setItem(i, "running", "running"));
        termLine(`<span class="t-dim">fanout instantiated · 4 items · maxConcurrency 3</span>`);
        /* everything downstream is relative to the items actually
           existing — never to a blanket delay */
        scheduleVerify();
      });
    });
  });
}

function scheduleVerify() {
  /* --- verify items --- */
  later(3300, () => {
    setItem(0, "complete", "\u2713 11s");
    bumpVerify();
    setItem(3, "running", "running");
    sendToken(edgeEls.fi0, 620, () => {});
  });
  later(4700, () => {
    setItem(1, "failed", "attempt 1 ✗");
    termLine(`<span class="t-err">✗</span> ${RETRY_KEY} <span class="t-dim">failed · attempt 1 · agent session lost</span>`);
    termLine(`<span class="t-dim">  the run holds its shape — one node, targeted retry:</span>`);
    showRetryKey();
  });
  later(8300, () => {
    if (!retryFired) fireRetry();
  });
  later(6800, () => {
    setItem(2, "complete", "\u2713 13s");
    bumpVerify();
    sendToken(edgeEls.fi2, 620, () => {});
  });
  later(10600, () => {
    setItem(3, "complete", "\u2713 10s");
    bumpVerify();
    sendToken(edgeEls.fi3, 620, () => {});
  });
  later(11800, () => {
    setItem(1, "complete", "\u2713 attempt 2");
    bumpVerify();
    sendToken(edgeEls.fi1, 620, () => {});
  });
  later(12400, () => {
    setNodeState("verify", "complete", "✓ 4/4");
    termLine(`<span class="t-ok">✓</span> verify_claims <span class="t-dim">completed · 4/4 · one targeted retry</span>`);
  });

  /* --- red team --- */
  later(13200, () => {
    setStatus("running — red_team", "is-running");
    setNodeState("redteam", "running", "running");
  });
  later(17000, () => {
    setNodeState("redteam", "complete", "✓ 2 objections");
    termLine(`<span class="t-ok">✓</span> red_team <span class="t-dim">completed · 2 objections upheld · 9.8s</span>`);
    sendToken(edgeEls.e3, 700, () => {
      setNodeState("gate", "awaiting", "awaiting signal");
      /* the tooltip grows out of the node, then the dashed line ties it in */
      $("#gateTip").hidden = false;
      const sig = edgeEls.sig;
      setTimeout(() => {
        sig.style.opacity = "";
        if (!REDUCED) sig.classList.add("draw");
        setTimeout(() => {
          sig.classList.remove("draw");
          sig.classList.add("is-calling");
        }, REDUCED ? 0 : 620);
      }, REDUCED ? 0 : 300);
      clock.held = true;
      setStatus("awaiting signal — publish_gate · the run holds", "is-awaiting");
      termLine(`<span class="t-await">…</span> publish_gate <span class="t-dim">awaiting signal · durable gate written</span>`);
    });
  });
}


function showRetryKey() {
  if (retryKeyEl) return;
  const it = itemEls[1];
  const frame = nodeEls.verify;
  const key = document.createElement("button");
  key.className = "retry-key";
  key.type = "button";
  key.innerHTML = `↻ retry verify[1] · auto in 3.5s`;
  const left = parseFloat(frame.style.left) + it.offsetLeft;
  const top = parseFloat(frame.style.top) + it.offsetTop + it.offsetHeight + 5;
  key.style.left = left + "px";
  key.style.top = top + "px";
  key.addEventListener("click", () => fireRetry());
  graphEl.appendChild(key);
  retryKeyEl = key;
}

function fireRetry() {
  if (retryFired) return;
  retryFired = true;
  if (retryKeyEl) {
    retryKeyEl.remove();
    retryKeyEl = null;
  }
  termCmd(`acpus runs retry ${RUN_ID} --target ${RETRY_KEY}`, () => {
    termLine(`<span class="t-gilt">↻</span> ${RETRY_KEY} <span class="t-dim">attempt 2 · targeted — everything else untouched</span>`);
  });
  setItem(1, "running", "attempt 2 · running");
}

/* approve the waiting signal (bound per tooltip render) */
function fireSignal() {
  if (approved) return;
  approved = true;
  $("#gateTip").hidden = true;
  edgeEls.sig.classList.remove("is-calling");
  edgeEls.sig.style.opacity = "0"; // the signal is consumed; the line dissolves
  termCmd(`acpus runs signal ${RUN_ID} --target publish_gate --payload '{"approved":true}'`, () => {
    termLine(`<span class="t-ok">✓</span> signal consumed <span class="t-dim">· publish_gate · {"approved":true}</span>`);
  });
  setNodeState("gate", "complete", "✓ approved");
  setStatus("running — write_report", "is-running");
  clock.held = false;

  later(300, () => {
    sendToken(edgeEls.e4, 650, () => setNodeState("report", "running", "running"));
  });
  later(3600, () => {
    setNodeState("report", "complete", "✓ report.md");
    addArtifact("fact-check-report.md");
    termLine(`<span class="t-ok">✓</span> write_report <span class="t-dim">completed · artifact fact-check-report.md · 2.1s</span>`);
  });
  later(4400, () => {
    setStatus("completed — 8 node instances · 6 agent executions · 1 signal · 1 retry · 1 artifact", "is-done");
    termLine(`<span class="t-ok">✓</span> run <span class="t-gilt">${RUN_ID}</span> <span class="t-ok">completed</span> <span class="t-dim">· durable state in ${RUN_DIR}</span>`);
    phase = "done";
    pauseBtn.hidden = true;
    resumeBtn.hidden = true;
    replayBtn.hidden = false;
    completePlate.hidden = false;
    completePlate.getBoundingClientRect();
    stageShell.inert = true;
    workbenchPage.classList.add("is-complete");
  });
}

/* pause / resume — real pause of the simulation clock */
pauseBtn.addEventListener("click", () => {
  if (phase !== "running" || clock.paused) return;
  clock.paused = true;
  stageEl.classList.add("is-paused");
  pauseBtn.hidden = true;
  resumeBtn.hidden = false;
  setStatus("paused — durable gate written · attempts wound down", "is-paused");
  termCmd(`acpus runs pause ${RUN_ID}`, () => {
    termLine(`<span class="t-gilt">⏸</span> pause gate written <span class="t-dim">· scheduler idle · state safe on disk</span>`);
  });
});

resumeBtn.addEventListener("click", () => {
  if (!clock.paused) return;
  clock.paused = false;
  stageEl.classList.remove("is-paused");
  resumeBtn.hidden = true;
  pauseBtn.hidden = false;
  setStatus(
    clock.held ? "awaiting signal — publish_gate · the run holds" : "running — pause gate cleared",
    clock.held ? "is-awaiting" : "is-running"
  );
  termCmd(`acpus runs resume ${RUN_ID}`, () => {
    termLine(
      `<span class="t-gilt">▶</span> pause gate cleared <span class="t-dim">· ${clock.held ? "signal gate still waiting" : "scheduler driving runnable work"}</span>`
    );
  });
});

/* skip the intro, keep the run */
skipBtn.addEventListener("click", () => {
  if (phase === "idle" || phase === "running" || phase === "done") return;
  phase = "running"; // bails any in-flight authoring/check/lowering chain
  lineEls.forEach((el) => el.classList.remove("is-pending", "is-fresh", "is-lit", "is-dim"));
  graphCol.hidden = false;
  stageBody.classList.remove("is-split");
  stageBody.classList.add("is-graph-full");
  ORDER.forEach((k) => { nodeEls[k].style.visibility = "visible"; });
  ["e1", "e2", "e3", "e4"].forEach((k) => { edgeEls[k].style.opacity = ""; });
  authoringStatus.hidden = true;
  codePanel.hidden = true;
  fitGraph(stageBody.clientWidth);
  setTimeout(() => fitGraph(), 580);
  startRun();
});

/* replay the run from a clean graph */
replayBtn.addEventListener("click", () => {
  workbenchPage.classList.remove("is-complete");
  stageShell.inert = false;
  setTimeout(() => { completePlate.hidden = true; }, REDUCED ? 0 : 180);
  termEl.innerHTML = "";
  trayItems.innerHTML = "";
  trayEl.hidden = true;
  if (retryKeyEl) { retryKeyEl.remove(); retryKeyEl = null; }
  clock.tokens.forEach((t) => t.el.remove());
  clock.tokens = [];
  codePanel.hidden = true;
  stageBody.classList.remove("is-split");
  stageBody.classList.add("is-graph-full");
  renderBaseGraph();
  ORDER.forEach((k) => { nodeEls[k].style.visibility = "visible"; });
  ["e1", "e2", "e3", "e4"].forEach((k) => { edgeEls[k].style.opacity = ""; });
  stageEl.classList.remove("is-paused");
  fitGraph();
  startRun();
});

/* endings */
const ENDING_NOTES = {
  delete: "Disposable for the task. The run record stays in the workspace; the file goes.",
  commit: "Durable when retained — reviewed, versioned, yours.",
  catalog: "Kept in .acpus/workflows — re-run it with new input, or let it travel with a skill.",
};

document.querySelectorAll(".complete-endings .ending").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".complete-endings .ending").forEach((b) => b.classList.remove("is-chosen"));
    btn.classList.add("is-chosen");
    const kind = btn.dataset.ending;
    const note = $("#endingNote");
    note.hidden = false;
    note.textContent = ENDING_NOTES[kind];
    const plate = $("#plate-" + kind);
    setTimeout(() => {
      plate.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" });
      document.querySelectorAll(".ending-plate").forEach((p) => p.classList.remove("is-chosen"));
      plate.classList.add("is-chosen");
    }, REDUCED ? 0 : 700);
  });
});

/* file tab — peek at the source behind the graph */
fileTab.addEventListener("click", () => {
  const open = codePanel.hidden;
  codePanel.classList.toggle("as-overlay", open);
  codePanel.hidden = !open;
  fileTab.setAttribute("aria-expanded", String(open));
});

const WORKBENCH_TRANSITION_MS = REDUCED ? 0 : 580;

function showStage() {
  clearTimeout(workbenchTransitionTimer);
  heroIntro.hidden = false;
  instrumentEl.setAttribute("aria-hidden", "false");
  heroIntro.setAttribute("aria-hidden", "true");
  requestAnimationFrame(() => {
    workbenchPage.classList.add("is-stage-active");
    workbenchTransitionTimer = setTimeout(() => {
      heroIntro.hidden = true;
      (workbenchPage.classList.contains("is-complete") ? taskBtn : stageEl).focus({ preventScroll: true });
    }, WORKBENCH_TRANSITION_MS);
  });
}

function showTask() {
  clearTimeout(workbenchTransitionTimer);
  heroIntro.hidden = false;
  instrumentEl.setAttribute("aria-hidden", "true");
  heroIntro.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    workbenchPage.classList.remove("is-stage-active");
    workbenchTransitionTimer = setTimeout(() => {
      taskCard.focus({ preventScroll: true });
    }, WORKBENCH_TRANSITION_MS);
  });
}

/* delegate — starts once, then becomes the way back to the live run */
delegateBtn.addEventListener("click", () => {
  if (!hasDelegated) {
    hasDelegated = true;
    delegateLabel.textContent = "Return to stage";
    delegateBtn.setAttribute("aria-label", "Return to the simulation stage");
    taskBtn.hidden = false;
    setStatus("authoring — an agent is writing workflow.ts", "is-running");
    authorCode(() => runCheck(() => lowerGraph(finishLowering)));
  }
  showStage();
});

taskBtn.addEventListener("click", showTask);

/* ------------------------------------------------------------
   recast toy — fork with a new agent mapping
   ------------------------------------------------------------ */

const TOY_BASE = [
  { id: "research", agent: "pi" },
  { id: "implement", agent: "claude" },
  { id: "review", agent: "pi" },
  { id: "synthesize", agent: "claude" },
];

const toyChain = $("#toyChain");
const toyPicker = $("#toyPicker");
const toyEcho = $("#toyEcho");
const toyResult = $("#toyResult");
let toyState = TOY_BASE.map((n) => ({ ...n }));

function renderToy() {
  toyChain.innerHTML = "";
  toyState.forEach((n, i) => {
    if (i > 0) {
      const link = document.createElement("span");
      link.className = "toy-link";
      toyChain.appendChild(link);
    }
    const el = document.createElement("div");
    el.className = "toy-node";
    el.dataset.idx = i;
    el.innerHTML = `
      <div class="tn-id"><span class="dot" style="background:var(--st-ok)"></span><span>${n.id}</span></div>
      <button class="tn-agent" type="button" data-idx="${i}">${n.agent} ▾</button>
      <div class="tn-verdict">completed</div>`;
    toyChain.appendChild(el);
  });
  toyChain.querySelectorAll(".tn-agent").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openToyPicker(b, Number(b.dataset.idx));
    })
  );
}

function openToyPicker(badge, idx) {
  toyPicker.innerHTML = "";
  AGENTS.forEach((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a;
    if (a === toyState[idx].agent) b.classList.add("is-current");
    b.addEventListener("click", () => {
      toyPicker.hidden = true;
      if (a !== toyState[idx].agent) applyRecast(idx, a);
    });
    toyPicker.appendChild(b);
  });
  const toy = $("#recastToy");
  toyPicker.style.left = Math.min(badge.offsetLeft, toy.clientWidth - 310) + "px";
  toyPicker.style.top = badge.offsetTop + badge.offsetHeight + 8 + "px";
  toyPicker.hidden = false;
}

document.addEventListener("click", (e) => {
  if (!toyPicker.hidden && !toyPicker.contains(e.target)) toyPicker.hidden = true;
});

function applyRecast(idx, agent) {
  toyState[idx].agent = agent;
  const nodes = toyChain.querySelectorAll(".toy-node");
  nodes.forEach((el, i) => {
    const verdict = el.querySelector(".tn-verdict");
    el.classList.remove("is-reused", "is-rerun", "is-changed");
    if (i < idx) {
      el.classList.add("is-reused");
      verdict.textContent = "reused ✓";
    } else {
      el.classList.add("is-rerun");
      verdict.textContent = i === idx ? "recast" : "will re-run";
    }
  });
  nodes[idx].classList.add("is-changed");
  nodes[idx].querySelector(".tn-agent").textContent = `${agent} ▾`;

  toyEcho.classList.add("is-cmd");
  toyEcho.textContent = `acpus runs fork ${RUN_ID} --agents ${toyState[idx].id}=${agent}`;
  toyResult.hidden = false;
  toyResult.innerHTML =
    `<span class="tr-reuse">✓ reuses ${idx} compatible completed fact${idx === 1 ? "" : "s"}</span>` +
    ` · <span class="tr-rerun">↻ re-runs ${toyState.length - idx} node${toyState.length - idx === 1 ? "" : "s"}</span>` +
    ` · same graph, new cast` +
    `<button class="tr-reset" type="button">reset</button>`;
  toyResult.querySelector(".tr-reset").addEventListener("click", resetToy);
}

function resetToy() {
  toyState = TOY_BASE.map((n) => ({ ...n }));
  renderToy();
  toyEcho.classList.remove("is-cmd");
  toyEcho.textContent = "click a node's agent badge to recast it";
  toyResult.hidden = true;
}

/* ------------------------------------------------------------
   scroll reveals
   ------------------------------------------------------------ */

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        en.target.classList.add("is-in");
        revealObserver.unobserve(en.target);
      }
    });
  },
  { threshold: 0.12 }
);

document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));

/* ------------------------------------------------------------
   boot
   ------------------------------------------------------------ */

renderBaseGraph();
renderToy();
if (REDUCED) {
  sizeHeroPhrase();
  heroTagline.classList.remove("is-waiting");
} else void animateHeroTagline();
