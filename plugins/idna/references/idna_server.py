#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""IDNA central server — routes all sessions from ~/.roxabi/idna/.

Usage:
    uv run idna_server.py [port]   (default: 8082)

Routes:
    GET  /                                  — index of all sessions
    GET  /<project>/<subject>/              — session picker
    GET  /<project>/<subject>/round_N/...   — static images
    GET  /<project>/<subject>/api/status
    GET  /<project>/<subject>/api/tree
    POST /<project>/<subject>/api/pick      — {"node_id": "v0"}
    POST /<project>/<subject>/api/finalize
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("idna")

IDNA_DIR = Path(__file__).parent
IMAGECLI_PROJECT = Path.home() / "projects" / "imageCLI"

# ── Resolution ────────────────────────────────────────────────────────────────
TREE_WIDTH   = 384   # low-res for all tree nodes (fast selection)
TREE_HEIGHT  = 512
FINAL_WIDTH  = 768   # hi-res re-gen of winner at finalize
FINAL_HEIGHT = 1024

# ── Per-session state ─────────────────────────────────────────────────────────

_locks: dict[str, threading.Lock] = {}
_workers: dict[str, threading.Thread] = {}


def _key(project: str, subject: str) -> str:
    return f"{project}/{subject}"


def _lock(project: str, subject: str) -> threading.Lock:
    k = _key(project, subject)
    if k not in _locks:
        _locks[k] = threading.Lock()
    return _locks[k]


def _session_dir(project: str, subject: str) -> Path:
    return IDNA_DIR / project / subject


def _session_file(project: str, subject: str) -> Path:
    return _session_dir(project, subject) / "session.json"


def read_session(project: str, subject: str) -> dict:
    with _lock(project, subject):
        return json.loads(_session_file(project, subject).read_text())


def write_session(project: str, subject: str, session: dict) -> None:
    with _lock(project, subject):
        _session_file(project, subject).write_text(json.dumps(session, indent=2))


def _is_new_format(session: dict) -> bool:
    return "nodes" in session


# ── Session discovery ─────────────────────────────────────────────────────────

def discover_sessions() -> list[dict]:
    sessions = []
    for f in sorted(IDNA_DIR.glob("*/*/session.json")):
        try:
            data = json.loads(f.read_text())
            project = f.parent.parent.name
            subject = f.parent.name
            if _is_new_format(data):
                path = data.get("path", [])
                winner_node = None
                if data.get("winner"):
                    winner_node = data["nodes"].get(data["winner"])
                sessions.append({
                    "project": project,
                    "subject": subject,
                    "url": f"/{project}/{subject}/",
                    "gen_status": data.get("gen_status", "idle"),
                    "phase": data.get("phase", "picking"),
                    "round": len(path),
                    "winner": winner_node,
                    "format": "new",
                })
            else:
                sessions.append({
                    "project": project,
                    "subject": subject,
                    "url": f"/{project}/{subject}/",
                    "gen_status": data.get("status", "unknown"),
                    "phase": data.get("phase", "explore"),
                    "round": data.get("round", 0),
                    "winner": data.get("winner"),
                    "format": "legacy",
                })
        except Exception:
            pass
    return sessions


# ── Generation worker ─────────────────────────────────────────────────────────

def _node_round(node_id: str) -> int:
    """Return round number from node id (e.g. 'v0-va-vb' -> 2)."""
    return node_id.count("-")


def _node_children_ids(node_id: str) -> list[str]:
    """Return the 3 child ids for a given node."""
    return [f"{node_id}-va", f"{node_id}-vb", f"{node_id}-vc"]


def _ensure_job_file(sdir: Path, node: dict, session: dict | None = None) -> None:
    """Write job JSON for a node if it doesn't exist yet."""
    round_num = node["round"]
    prompts_dir = sdir / f"round_{round_num}" / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    job_file = prompts_dir / f"{node['id']}.json"
    if not job_file.exists():
        seed_base = round_num * 100
        mutation_idx = {"va": 0, "vb": 1, "vc": 2}
        suffix = node["id"].rsplit("-", 1)[-1] if "-" in node["id"] else node["id"].lstrip("v")
        if suffix in mutation_idx:
            seed = seed_base + mutation_idx[suffix]
        else:
            seed = int(suffix) if suffix.isdigit() else 0
        # Use template resolution constants if available
        w, h = TREE_WIDTH, TREE_HEIGHT
        if session:
            try:
                from templates import get_template
                tmpl = get_template(session.get("template", "avatar"))
                w = getattr(tmpl, "TREE_WIDTH", TREE_WIDTH)
                h = getattr(tmpl, "TREE_HEIGHT", TREE_HEIGHT)
            except Exception:
                pass
        job = {
            "id": node["id"],
            "label": node["label"],
            "mutation": node.get("mutation"),
            "seed": seed,
            "width": w,
            "height": h,
            "prompt": node["prompt"],
        }
        job_file.write_text(json.dumps(job, indent=2))


def _get_artifact_type(session: dict) -> str:
    """Get artifact_type from session template. Defaults to 'image' for legacy sessions."""
    template_name = session.get("template", "avatar")
    try:
        sys.path.insert(0, str(IDNA_DIR))
        from templates import get_template
        return get_template(template_name).artifact_type
    except Exception:
        return "image"


def _generation_worker(project: str, subject: str) -> None:
    """BFS generation worker: processes queue in batches grouped by round."""
    sdir = _session_dir(project, subject)
    generate_script = Path(__file__).parent / "idna_generate_round.py"

    log.info("Generation worker started: %s/%s", project, subject)

    session = read_session(project, subject)
    artifact_type = _get_artifact_type(session)

    # html/text nodes are already rendered by build_tree — nothing to do
    if artifact_type in ("html", "text"):
        log.info("Generation worker: artifact_type=%s, no generation needed", artifact_type)
        session["gen_status"] = "idle"
        write_session(project, subject, session)
        return

    # audio: TODO — voiceCLI integration not yet implemented
    if artifact_type == "audio":
        log.warning("Generation worker: audio artifact_type — voiceCLI integration TODO")
        session["gen_status"] = "idle"
        write_session(project, subject, session)
        return

    while True:
        session = read_session(project, subject)
        if not _is_new_format(session):
            break

        nodes = session.get("nodes", {})
        path = session.get("path", [])
        actionable = {"pending", "encoded"}

        # Lazy generation: only generate children of the last picked node.
        # Round 0 is handled by the SSE /api/new handler directly.
        if not path:
            pending = []
        else:
            parent = path[-1]
            children = [f"{parent}-va", f"{parent}-vb", f"{parent}-vc"]
            pending = [nid for nid in children if nodes.get(nid, {}).get("status") in actionable]

        if not pending:
            session["gen_status"] = "idle"
            write_session(project, subject, session)
            log.info("Generation worker idle: %s/%s (waiting for pick)", project, subject)
            break

        batch_round = _node_round(pending[0])
        batch = pending

        log.info("Generating batch: round %d, %d nodes (%s)", batch_round, len(batch), batch)

        # Kill any orphaned imageCLI processes before loading VRAM
        _kill_stale_imagecli()

        # Ensure job files exist for all batch nodes
        for nid in batch:
            node = nodes.get(nid)
            if node and node.get("prompt"):
                _ensure_job_file(sdir, node, session)

        # Run idna_generate_round.py for this round directory
        round_dir = sdir / f"round_{batch_round}"
        round_dir.mkdir(parents=True, exist_ok=True)
        (round_dir / "embeds").mkdir(exist_ok=True)

        result = subprocess.run(
            [
                "uv", "run", "--project", str(IMAGECLI_PROJECT),
                "python", str(generate_script),
                str(round_dir), "--steps", "15",
            ],
            capture_output=False, text=True,
        )

        # Re-read session in case queue was reordered by pick
        session = read_session(project, subject)
        nodes = session["nodes"]

        if result.returncode != 0:
            log.error("idna_generate_round.py failed for round %d (exit %d)", batch_round, result.returncode)
            for nid in batch:
                if nid in nodes:
                    nodes[nid]["status"] = "error"
            session["nodes"] = nodes
            session["gen_status"] = "error"
            write_session(project, subject, session)
            log.error("Generation worker stopping after round %d failure", batch_round)
            break
        else:
            for nid in batch:
                if nid in nodes:
                    img_path = sdir / f"round_{batch_round}" / f"{nid}.png"
                    if img_path.exists():
                        nodes[nid]["status"] = "ready"
                    else:
                        nodes[nid]["status"] = "error"

        write_session(project, subject, session)

    log.info("Generation worker exited: %s/%s", project, subject)


def _kill_stale_imagecli() -> None:
    """Kill any orphaned imageCLI python processes holding VRAM before starting a new one."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "idna_generate_round.py"],
            capture_output=True, text=True,
        )
        for pid_str in result.stdout.strip().splitlines():
            pid = int(pid_str.strip())
            if pid == os.getpid():
                continue
            try:
                os.kill(pid, signal.SIGTERM)
                log.info("Killed stale imageCLI process pid=%d", pid)
            except ProcessLookupError:
                pass
    except Exception as e:
        log.warning("_kill_stale_imagecli: %s", e)


def _ensure_worker(project: str, subject: str) -> None:
    """Start generation worker if not already running."""
    k = _key(project, subject)
    if k not in _workers or not _workers[k].is_alive():
        t = threading.Thread(target=_generation_worker, args=(project, subject), daemon=True)
        _workers[k] = t
        t.start()


# ── HTTP routing ──────────────────────────────────────────────────────────────

def _parse_path(path: str) -> tuple[str | None, str | None, str]:
    """Return (project, subject, rest) or (None, None, path) for index."""
    parts = path.lstrip("/").split("/")
    if len(parts) >= 2:
        project, subject = parts[0], parts[1]
        if project and subject and (_session_dir(project, subject) / "session.json").exists():
            rest = "/" + "/".join(parts[2:]) if len(parts) > 2 else "/"
            return project, subject, rest
    return None, None, path


# ── HTML templates ────────────────────────────────────────────────────────────

def _index_html(sessions: list[dict]) -> str:
    status_color = {
        "generating": "#e8a030", "encoding": "#a78bfa", "building": "#22d3ee",
        "idle": "#34d399", "done": "#34d399", "error": "#f87171",
        "ready": "#22d3ee",
    }
    cards = ""
    for s in sessions:
        gen_status = s.get("gen_status", "unknown")
        color = status_color.get(gen_status, "#7d8799")
        winner_img = ""
        if s.get("winner"):
            w = s["winner"]
            img = w.get("image") if isinstance(w, dict) else None
            if img:
                winner_img = f'<img src="/{s["project"]}/{s["subject"]}/{img}" alt="winner">'
        label = s.get("gen_status") or s.get("status", "unknown")
        cards += f"""
    <a class="card" href="{s['url']}">
      <div class="card-thumb">{winner_img}</div>
      <div class="card-body">
        <div class="card-project">{s['project']}</div>
        <div class="card-subject">{s['subject']}</div>
        <div class="card-meta">
          <span class="badge" style="border-color:{color};color:{color}">{label}</span>
          <span class="dim">round {s['round']} · {s['phase']}</span>
        </div>
      </div>
    </a>"""
    empty = '<div class="empty">No sessions yet. Hit <strong>+ New</strong> to start one.</div>' if not sessions else ""
    return f"""<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IDNA — Idea DNA</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{{--bg:#0c0e16;--surface:#13161f;--border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
  --text:#dde4f0;--text-dim:#7d8799;--accent:#e8a030;--teal:#22d3ee;
  --font:'Plus Jakarta Sans',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;--radius:12px}}
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
html{{font-size:15px;-webkit-font-smoothing:antialiased}}
body{{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;padding:40px 24px 80px}}
.layout{{max-width:900px;margin:0 auto}}
.header{{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:36px;flex-wrap:wrap}}
.header-text .mono{{font-family:var(--mono);font-size:.72rem;color:var(--teal);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}}
h1{{font-size:1.8rem;font-weight:700;letter-spacing:-.02em}}
h1 span{{color:var(--accent)}}
.sub{{font-size:.85rem;color:var(--text-dim);margin-top:6px}}
.btn-new{{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;background:var(--accent);color:#0c0e16;
  border:none;border-radius:8px;font-family:var(--font);font-size:.9rem;font-weight:700;cursor:pointer;
  transition:opacity .15s;white-space:nowrap;align-self:center}}
.btn-new:hover{{opacity:.88}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}}
.card{{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius);
  background:var(--surface);overflow:hidden;text-decoration:none;color:inherit;
  transition:border-color .18s,transform .15s}}
.card:hover{{border-color:var(--border2);transform:translateY(-2px)}}
.card-thumb{{width:100%;aspect-ratio:3/4;background:#0a0c14;overflow:hidden;display:flex;align-items:center;justify-content:center}}
.card-thumb img{{width:100%;height:100%;object-fit:cover}}
.card-thumb:empty::after{{content:'No image yet';font-family:var(--mono);font-size:.7rem;color:var(--text-dim)}}
.card-body{{padding:14px}}
.card-project{{font-family:var(--mono);font-size:.68rem;color:var(--teal);text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px}}
.card-subject{{font-size:1rem;font-weight:600;margin-bottom:10px}}
.card-meta{{display:flex;align-items:center;gap:8px;flex-wrap:wrap}}
.badge{{font-family:var(--mono);font-size:.65rem;padding:2px 7px;border-radius:4px;border:1px solid;font-weight:600}}
.dim{{font-family:var(--mono);font-size:.68rem;color:var(--text-dim)}}
.empty{{color:var(--text-dim);font-size:.9rem;padding:40px 0;text-align:center}}
.empty strong{{color:var(--accent)}}
/* Modal */
.overlay{{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);display:flex;
  align-items:center;justify-content:center;z-index:100;opacity:0;pointer-events:none;transition:opacity .2s}}
.overlay.open{{opacity:1;pointer-events:all}}
.modal{{background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:28px;
  width:min(520px,calc(100vw - 32px));display:flex;flex-direction:column;gap:20px}}
.modal h2{{font-size:1.2rem;font-weight:700}}
.modal h2 span{{color:var(--accent)}}
.field{{display:flex;flex-direction:column;gap:6px}}
.field label{{font-size:.8rem;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em}}
.field input,.field textarea,.field select{{background:#0a0c14;border:1px solid var(--border2);border-radius:8px;
  color:var(--text);font-family:var(--font);font-size:.95rem;padding:10px 12px;outline:none;
  transition:border-color .15s;width:100%}}
.field input:focus,.field textarea:focus,.field select:focus{{border-color:var(--accent)}}
.field textarea{{min-height:90px;resize:vertical;line-height:1.5}}
.field select option{{background:#13161f}}
.row{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
.modal-footer{{display:flex;gap:10px;justify-content:flex-end}}
.btn-cancel{{padding:9px 18px;background:transparent;border:1px solid var(--border2);border-radius:8px;
  color:var(--text-dim);font-family:var(--font);font-size:.9rem;cursor:pointer;transition:border-color .15s}}
.btn-cancel:hover{{border-color:var(--text-dim)}}
.btn-create{{padding:9px 22px;background:var(--accent);border:none;border-radius:8px;
  color:#0c0e16;font-family:var(--font);font-size:.9rem;font-weight:700;cursor:pointer;transition:opacity .15s}}
.btn-create:hover{{opacity:.88}}
.btn-create:disabled{{opacity:.45;cursor:not-allowed}}
.steps{{display:flex;flex-direction:column;gap:8px}}
.step{{display:flex;align-items:center;gap:10px;font-size:.88rem;opacity:.35;transition:opacity .2s}}
.step.active{{opacity:1}}.step.done{{opacity:.7}}.step.error{{opacity:1;color:#f87171}}
.step-icon{{width:18px;height:18px;flex-shrink:0}}
.step-spinner{{width:18px;height:18px;border:2px solid rgba(255,255,255,.15);border-top-color:var(--teal);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}}
.step-detail{{font-size:.75rem;color:var(--text-dim);font-family:var(--mono);margin-top:2px}}
@keyframes spin{{to{{transform:rotate(360deg)}}}}
</style>
</head>
<body>
<div class="layout">
  <div class="header">
    <div class="header-text">
      <div class="mono">IDNA / Idea DNA</div>
      <h1>Evolutionary <span>Selectors</span></h1>
      <div class="sub">Active sessions — click to open picker</div>
    </div>
    <button class="btn-new" onclick="openModal()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      New selector
    </button>
  </div>
  <div class="grid">{cards}</div>
  {empty}
</div>

<div class="overlay" id="overlay" onclick="maybeClose(event)">
  <div class="modal" id="modal">
    <h2>New <span>Selector</span></h2>
    <div class="row">
      <div class="field">
        <label>Project</label>
        <input id="f-project" placeholder="lyra" autocomplete="off">
      </div>
      <div class="field">
        <label>Subject</label>
        <input id="f-subject" placeholder="avatar" autocomplete="off">
      </div>
    </div>
    <div class="field">
      <label>What do you want to select?</label>
      <textarea id="f-intent" placeholder="e.g. brand color palette for a dark SaaS dashboard — warm, modern, accessible"></textarea>
    </div>
    <div class="row">
      <div class="field">
        <label>Template (optional)</label>
        <select id="f-template">
          <option value="">— auto-detect —</option>
          <option value="color-palette">Color palette</option>
          <option value="avatar">Avatar / persona</option>
          <option value="logo">Logo concept</option>
          <option value="ui-component">UI component</option>
          <option value="icon-set">Icon set</option>
          <option value="motion-curve">Motion curve</option>
          <option value="voice">Voice style</option>
        </select>
      </div>
      <div class="field">
        <label>Depth</label>
        <select id="f-depth">
          <option value="2">2 — 52 nodes</option>
          <option value="3" selected>3 — 160 nodes</option>
          <option value="4">4 — 484 nodes</option>
        </select>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Width</label>
        <select id="f-width">
          <option value="3">3 variants</option>
          <option value="4" selected>4 variants</option>
          <option value="5">5 variants</option>
        </select>
      </div>
    </div>
    <div class="steps" id="steps-ui" style="display:none">
      <div class="step" id="step-vocabulary"><span class="step-icon">&#9679;</span><div><div>Vocabulary</div><div class="step-detail" id="detail-vocabulary">Designing your selector with Claude</div></div></div>
      <div class="step" id="step-tree"><span class="step-icon">&#9679;</span><div><div>Tree</div><div class="step-detail" id="detail-tree">Building exploration tree</div></div></div>
      <div class="step" id="step-encode"><span class="step-icon">&#9679;</span><div><div>Encode</div><div class="step-detail" id="detail-encode">Text encoder — all prompts</div></div></div>
      <div class="step" id="step-generate"><span class="step-icon">&#9679;</span><div><div>Generate round 0</div><div class="step-detail" id="detail-generate">FLUX — first images</div></div></div>
      <div class="step" id="step-ready"><span class="step-icon">&#9679;</span><div><div>Ready</div><div class="step-detail" id="detail-ready">Opening picker</div></div></div>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-create" id="btn-create" onclick="createSession()">Create</button>
    </div>
  </div>
</div>

<script>
function openModal() {{
  document.getElementById('overlay').classList.add('open');
  document.getElementById('f-intent').focus();
}}
function closeModal() {{
  if (document.getElementById('btn-create').disabled) return;
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('steps-ui').style.display = 'none';
  ['vocabulary','tree','generate','ready'].forEach(s => {{
    const el = document.getElementById('step-'+s);
    el.className = 'step';
    el.querySelector('.step-icon,.step-spinner') && (el.querySelector('.step-icon,.step-spinner').outerHTML = '<span class="step-icon">&#9679;</span>');
  }});
}}
function maybeClose(e) {{
  if (e.target === document.getElementById('overlay')) closeModal();
}}
document.addEventListener('keydown', e => {{ if (e.key === 'Escape') closeModal(); }});

const STEP_ICONS = {{
  done: '<svg class="step-icon" viewBox="0 0 18 18" fill="none" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,9 7,13 15,5"/></svg>',
  error: '<svg class="step-icon" viewBox="0 0 18 18" fill="none" stroke="#f87171" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="4" x2="14" y2="14"/><line x1="14" y1="4" x2="4" y2="14"/></svg>',
}};

function setStep(name, status, message) {{
  const el = document.getElementById('step-'+name);
  if (!el) return;
  el.className = 'step ' + (status === 'running' ? 'active' : status === 'done' ? 'done' : status === 'error' ? 'error' : '');
  const iconEl = el.querySelector('.step-icon,.step-spinner');
  if (iconEl) iconEl.outerHTML = status === 'running'
    ? '<span class="step-spinner"></span>'
    : status === 'done' ? STEP_ICONS.done
    : status === 'error' ? STEP_ICONS.error
    : '<span class="step-icon">&#9679;</span>';
  const detail = document.getElementById('detail-'+name);
  if (detail && message) detail.textContent = message;
}}

async function createSession() {{
  const project  = document.getElementById('f-project').value.trim();
  const subject  = document.getElementById('f-subject').value.trim();
  const intent   = document.getElementById('f-intent').value.trim();
  const template = document.getElementById('f-template').value;
  const depth    = parseInt(document.getElementById('f-depth').value);
  const width    = parseInt(document.getElementById('f-width').value);

  if (!project || !subject || !intent) {{
    setStep('vocabulary', 'error', 'Project, subject, and intent are required.');
    document.getElementById('steps-ui').style.display = 'flex';
    return;
  }}

  const btn = document.getElementById('btn-create');
  btn.disabled = true;
  document.getElementById('steps-ui').style.display = 'flex';

  try {{
    const response = await fetch('/api/new', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{ project, subject, intent, template, depth, width }}),
    }});

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {{
      const {{ done, value }} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {{ stream: true }});
      const parts = buffer.split('\\n\\n');
      buffer = parts.pop();
      for (const part of parts) {{
        if (!part.startsWith('data: ')) continue;
        try {{
          const ev = JSON.parse(part.slice(6));
          if (ev.step === 'ready') {{
            setStep('ready', 'done', ev.message);
            setTimeout(() => window.location.href = ev.url, 600);
          }} else if (ev.status === 'error') {{
            if (ev.step) setStep(ev.step, 'error', ev.message);
            btn.disabled = false;
          }} else {{
            setStep(ev.step, ev.status, ev.message);
          }}
        }} catch(e) {{}}
      }}
    }}
  }} catch(e) {{
    setStep('vocabulary', 'error', 'Network error: ' + e.message);
    btn.disabled = false;
  }}
}}
</script>
</body>
</html>"""


PICKER_HTML = r"""<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IDNA — Picker</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#0c0e16; --surface:#13161f; --surface2:#1a1d2a; --card:#1e2133;
  --border:rgba(255,255,255,0.07); --border2:rgba(255,255,255,0.13);
  --text:#dde4f0; --text-dim:#7d8799; --text-xdim:#3e4556;
  --accent:#e8a030; --accent-dim:rgba(232,160,48,0.15);
  --teal:#22d3ee; --teal-dim:rgba(34,211,238,0.12);
  --font:'Plus Jakarta Sans',system-ui,sans-serif;
  --mono:'JetBrains Mono',monospace;
  --radius:12px;
}
[data-theme="light"] {
  --bg:#f5f2ec; --surface:#ede9e0; --card:#faf8f4;
  --border:rgba(0,0,0,0.08); --border2:rgba(0,0,0,0.15);
  --text:#1a1d2b; --text-dim:#5a6070; --text-xdim:#9aa0ae;
  --accent:#b8760a; --accent-dim:rgba(184,118,10,0.1);
  --teal:#0891b2; --teal-dim:rgba(8,145,178,0.1);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:15px;-webkit-font-smoothing:antialiased}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh}
.layout{max-width:960px;margin:0 auto;padding:32px 24px 80px}
.header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:28px}
.back{font-size:.75rem;font-family:var(--mono);color:var(--teal);text-decoration:none;display:flex;align-items:center;gap:4px;margin-bottom:6px;opacity:.75}
.back:hover{opacity:1}
.project{font-size:.72rem;font-family:var(--mono);color:var(--teal);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}
.title{font-size:1.5rem;font-weight:700;letter-spacing:-.02em}
.title span{color:var(--accent)}
.subtitle{font-size:.82rem;color:var(--text-dim);margin-top:4px}
.hdr-btns{display:flex;gap:8px;flex-shrink:0;margin-top:4px}
.theme-btn,.back-btn{background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text-dim);cursor:pointer;font-size:.82rem;padding:5px 12px}
.theme-btn:hover,.back-btn:hover{border-color:var(--accent);color:var(--accent)}
.back-btn:disabled{opacity:.3;pointer-events:none}
.phasebar{display:flex;align-items:center;gap:8px;margin-bottom:24px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px}
.phase{display:flex;align-items:center;gap:6px;font-size:.78rem;font-weight:500;color:var(--text-xdim)}
.phase.done{color:var(--text-dim)}.phase.active{color:var(--text)}
.phase-dot{width:8px;height:8px;border-radius:50%;background:var(--text-xdim);flex-shrink:0}
.phase.done .phase-dot{background:var(--teal)}.phase.active .phase-dot{background:var(--accent)}
.phase-sep{flex:1;height:1px;background:var(--border)}
.round-badge{margin-left:auto;font-size:.72rem;font-family:var(--mono);color:var(--accent);background:var(--accent-dim);border:1px solid var(--accent);border-radius:5px;padding:3px 8px}
.breadcrumb{display:flex;align-items:center;gap:6px;margin-bottom:20px;flex-wrap:wrap}
.crumb{font-size:.75rem;font-family:var(--mono);color:var(--text-dim);padding:3px 8px;background:var(--surface);border:1px solid var(--border);border-radius:5px}
.crumb.active{color:var(--accent);border-color:var(--accent);background:var(--accent-dim)}
.crumb-sep{color:var(--text-xdim);font-size:.75rem}
.info-strip{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:20px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px}
.info-item{font-size:.74rem;color:var(--text-dim);display:flex;gap:5px;align-items:center}
.info-item .label{color:var(--text-xdim);font-family:var(--mono)}
.info-item .val{color:var(--text)}
.grid-4{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:24px}
@media(max-width:640px){.grid-4,.grid-3{grid-template-columns:1fr}}
.card{position:relative;border-radius:var(--radius);border:2px solid var(--border);background:var(--surface);overflow:hidden;cursor:pointer;transition:border-color .18s,transform .15s,box-shadow .18s;user-select:none}
.card:hover{border-color:var(--border2);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.35)}
.card.selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),0 8px 32px rgba(232,160,48,.25)}
.card.selected::after{content:'';position:absolute;inset:0;border-radius:calc(var(--radius) - 2px);background:rgba(232,160,48,.06);pointer-events:none}
.card.not-ready{cursor:default}
.card.not-ready:hover{transform:none;border-color:var(--border)}
.card-img-wrap{position:relative;width:100%;aspect-ratio:3/4;background:#0a0c14;overflow:hidden}
.card-embed-wrap{position:relative;width:100%;aspect-ratio:4/3;background:#0a0c14;overflow:hidden}
.card-embed-wrap iframe{width:100%;height:100%;border:none;pointer-events:none}
.card-audio-wrap{position:relative;width:100%;padding:1.5rem 1rem;background:#0a0c14;display:flex;flex-direction:column;align-items:center;gap:1rem;min-height:120px;justify-content:center}
.card-audio-wrap .audio-icon{font-size:2rem;opacity:.3}
.card-audio-wrap audio{width:100%;max-width:260px}
.card-img-wrap img{display:block;width:100%;height:100%;object-fit:cover;transition:filter .3s}
.card.pending .card-img-wrap img,.card.encoding .card-img-wrap img{filter:blur(8px) brightness(.4)}
.card-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
.mini-spinner{width:28px;height:28px;border:2px solid rgba(255,255,255,.15);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
.placeholder-label{font-size:.7rem;font-family:var(--mono);color:var(--text-dim)}
.card.ready .card-placeholder{display:none}
.card-label{position:absolute;top:10px;left:10px;background:rgba(0,0,0,.65);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.12);border-radius:6px;font-family:var(--mono);font-size:.72rem;font-weight:600;color:#fff;padding:3px 8px;z-index:2}
.card.selected .card-label{background:rgba(232,160,48,.85);color:#0c0e16;border-color:transparent}
.card-mutation{position:absolute;top:10px;right:10px;font-size:.65rem;font-family:var(--mono);padding:2px 7px;border-radius:4px;border:1px solid;font-weight:700;z-index:2}
.mut-amplify{color:#f97316;border-color:rgba(249,115,22,.4);background:rgba(249,115,22,.15)}
.mut-blend{color:#a78bfa;border-color:rgba(167,139,250,.4);background:rgba(167,139,250,.15)}
.mut-refine{color:#34d399;border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.15)}
.card-check{position:absolute;bottom:10px;right:10px;width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(.6);transition:opacity .18s,transform .18s;z-index:2}
.card.selected .card-check{opacity:1;transform:scale(1)}
.card-check svg{width:12px;height:12px;stroke:#0c0e16;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.card-params{position:absolute;bottom:0;left:0;right:0;background:linear-gradient(0deg,rgba(0,0,0,.88) 0%,transparent 100%);padding:28px 10px 10px;opacity:0;transition:opacity .2s;z-index:2}
.card.ready:hover .card-params,.card.ready.selected .card-params{opacity:1}
.param-row{font-size:.68rem;color:rgba(255,255,255,.75);line-height:1.6;font-family:var(--mono)}
.param-key{color:var(--teal);margin-right:4px}
.footer{display:flex;align-items:center;gap:12px}
.pick-display{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:11px 16px;font-size:.85rem;color:var(--text-dim)}
.pick-display.has-pick{border-color:var(--accent);color:var(--text)}
.pick-value{font-family:var(--mono);color:var(--accent);font-weight:600}
.confirm-btn{background:var(--accent);color:#0c0e16;border:none;border-radius:8px;font-family:var(--font);font-size:.88rem;font-weight:700;padding:11px 24px;cursor:pointer;opacity:.35;pointer-events:none;flex-shrink:0;transition:opacity .18s}
.confirm-btn.ready{opacity:1;pointer-events:auto}
.confirm-btn.ready:hover{opacity:.88}
.finalize-btn{background:transparent;color:var(--teal);border:1px solid var(--teal);border-radius:8px;font-family:var(--font);font-size:.82rem;font-weight:600;padding:10px 16px;cursor:pointer;flex-shrink:0;transition:opacity .18s,background .18s}
.finalize-btn:hover{background:var(--teal-dim)}
.gen-status-bar{display:flex;align-items:center;gap:10px;margin-bottom:20px;padding:10px 16px;background:var(--surface);border:1px solid var(--border2);border-radius:8px;font-size:.78rem}
.gen-status-bar .spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.15);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}
.gen-status-label{color:var(--text-dim);font-family:var(--mono)}
.gen-status-val{color:var(--accent);font-weight:600}
.queue-count{margin-left:auto;font-size:.7rem;font-family:var(--mono);color:var(--text-xdim)}
.done-panel{display:none;flex-direction:column;align-items:center;gap:20px;padding:40px 20px;text-align:center}
.done-panel.visible{display:flex}
.done-panel img{width:200px;border-radius:var(--radius);border:2px solid var(--teal)}
.done-title{font-size:1.3rem;font-weight:700}
.done-sub{font-size:.85rem;color:var(--text-dim)}
.error-bar{display:none;padding:10px 16px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);border-radius:8px;font-size:.8rem;color:#f87171;margin-bottom:16px;font-family:var(--mono)}
.error-bar.visible{display:block}
.card-img-wrap img {transition: opacity 0.4s;}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="layout" id="app">
  <div class="header">
    <div>
      <a class="back" href="/">← all sessions</a>
      <div class="project" id="proj-label">IDNA</div>
      <div class="title" id="title">Loading…</div>
      <div class="subtitle" id="subtitle"></div>
    </div>
    <div class="hdr-btns">
      <button class="back-btn" id="back-btn" onclick="goBack()" disabled>← Back</button>
      <button class="theme-btn" onclick="toggleTheme()">☀ / ☾</button>
    </div>
  </div>
  <div class="error-bar" id="error-bar"></div>
  <div id="main-content"></div>
</div>
<script>
let state = null, treeNodes = null, selected = null, pollTimer = null, confirming = false, artifactType = 'image';

function toggleTheme() {
  document.documentElement.dataset.theme =
    document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 't') { toggleTheme(); return; }
  if (e.key === 'Backspace' && e.altKey) { goBack(); return; }
  if (!state || !treeNodes) return;
  const variants = currentVariants();
  if (!variants) return;
  const readyVariants = variants.filter(n => n.status === 'ready');
  const keys = ['1','2','3','4','a','b','c','d'];
  const idx = keys.indexOf(e.key);
  if (idx >= 0 && idx < readyVariants.length) { pick(readyVariants[idx].id); return; }
  if (e.key === 'Enter') confirmPick();
  if (e.key === 'f') finalize();
});

function currentRound() {
  return state ? (state.path || []).length : 0;
}

function currentVariants() {
  if (!treeNodes) return null;
  const path = state.path || [];
  const round = path.length;
  if (round === 0) {
    // Root nodes: all round-0 nodes
    return Object.values(treeNodes).filter(n => n.round === 0);
  }
  const parent = path[path.length - 1];
  return Object.values(treeNodes).filter(n => n.parent === parent);
}

function mutClass(m) {
  if (!m) return '';
  return {amplify:'mut-amplify', blend:'mut-blend', refine:'mut-refine'}[m.toLowerCase()] || '';
}

function smartUpdateCards(variants) {
  const grid = document.getElementById('grid');
  if (!grid) return false;
  // If any variant card is missing from the DOM, the round changed — force full rebuild
  if (variants.some(n => !document.getElementById('card-' + n.id))) return false;
  variants.forEach(node => {
    const card = document.getElementById('card-' + node.id);
    if (!card) return;
    const isReady = node.status === 'ready';
    const wasReady = card.classList.contains('ready');
    if (isReady === wasReady) return; // no change
    if (isReady) {
      // Let spinner complete one rotation, then fade in image
      const spinner = card.querySelector('.mini-spinner');
      if (spinner) spinner.style.animationIterationCount = '1';
      setTimeout(() => {
        card.classList.remove('pending', 'encoding');
        card.classList.add('ready');
        card.onclick = () => pick(node.id);
        const wrap = card.querySelector('.card-img-wrap');
        if (wrap && node.artifact) {
          const img = document.createElement('img');
          img.src = node.artifact;
          img.alt = node.label;
          img.loading = 'eager';
          img.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 0.4s';
          img.onload = () => { requestAnimationFrame(() => { img.style.opacity = '1'; }); };
          wrap.innerHTML = '';
          wrap.appendChild(img);
        }
        card.querySelector('.card-placeholder')?.remove();
      }, 750);
    } else {
      card.className = `card ${node.status}`;
    }
  });
  return true;
}

function render() {
  if (!state || !treeNodes) return;

  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length >= 2) {
    document.getElementById('proj-label').textContent = `${parts[0]} / ${parts[1]}`;
  }

  // Update back button
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.disabled = (state.path || []).length === 0;

  if (state.phase === 'done' || state.winner) {
    renderDone(); return;
  }

  renderPicker();
}

function renderPicker() {
  const path = state.path || [];
  const round = path.length;
  const variants = currentVariants() || [];
  const genStatus = state.gen_status || 'idle';
  const queueLen = state.queue_length || 0;

  // Smart card update: only update changed cards if grid already rendered
  if (document.getElementById('grid') && smartUpdateCards(variants)) {
    // Grid already exists — just update footer pick display
    const pd = document.getElementById('pick-display');
    if (pd) {
      pd.className = 'pick-display ' + (selected ? 'has-pick' : '');
      pd.innerHTML = selected
        ? `Selected: <span class="pick-value">${selected.toUpperCase()}</span>`
        : `Click a variant · or press ${variants.length<=3?'a / b / c':'1 / 2 / 3 / 4'} · Enter to confirm`;
    }
    const cb = document.getElementById('confirm-btn');
    if (cb) cb.className = 'confirm-btn ' + (selected ? 'ready' : '');
    return;
  }

  document.getElementById('title').innerHTML =
    round === 0 ? 'Explore <span>Round 0</span>' : `Converge <span>Round ${round}</span>`;
  document.getElementById('subtitle').textContent = round === 0
    ? 'Four diverse starting points — pick the strongest'
    : 'Amplify · Blend · Refine — pick the best mutation';

  const isGenerating = ['building','encoding','generating'].includes(genStatus);
  const allReady = variants.length > 0 && variants.every(n => n.status === 'ready');
  let html = '';

  // Phase bar
  html += `<div class="phasebar">
    <div class="phase-dot" style="background:${round>0?'var(--teal)':'var(--accent)'}"></div>
    <div class="phase ${round>0?'done':'active'}">Explore</div>
    <div class="phase-sep"></div>
    <div class="phase-dot" style="background:${round>=1?'var(--accent)':'var(--text-xdim)'}"></div>
    <div class="phase ${round>=1?'active':''}">Converge</div>
    <div class="phase-sep"></div>
    <div class="phase-dot"></div>
    <div class="phase">Finalize</div>
    <div class="round-badge">Round ${round}</div>
  </div>`;

  // Breadcrumb trail
  if (path.length > 0) {
    html += '<div class="breadcrumb"><span class="crumb">Root</span>';
    path.forEach((nid, i) => {
      const node = treeNodes[nid] || {};
      html += `<span class="crumb-sep">›</span>
        <span class="crumb ${i===path.length-1?'active':''}">${node.label||nid}</span>`;
    });
    html += '</div>';
  }

  // Gen status bar (when actively generating)
  if (isGenerating) {
    const statusLabels = {building:'Building tree…',encoding:'Encoding prompts…',generating:'Generating images…'};
    html += `<div class="gen-status-bar">
      <div class="spinner"></div>
      <span class="gen-status-label">gen_status</span>
      <span class="gen-status-val">${statusLabels[genStatus]||genStatus}</span>
      ${queueLen>0?`<span class="queue-count">${queueLen} in queue</span>`:''}
    </div>`;
  }

  // Info strip
  const infoByType = {
    image: `<div class="info-item"><span class="label">engine</span><span class="val">flux2-klein · fp8</span></div>
    <div class="info-item"><span class="label">steps</span><span class="val">15</span></div>`,
    html: `<div class="info-item"><span class="label">type</span><span class="val">inline HTML</span></div>`,
    audio: `<div class="info-item"><span class="label">type</span><span class="val">voiceCLI audio</span></div>`,
    text: `<div class="info-item"><span class="label">type</span><span class="val">text</span></div>`,
  };
  html += `<div class="info-strip">
    ${infoByType[artifactType]||''}
    <div class="info-item"><span class="label">gen</span><span class="val">${genStatus}</span></div>
  </div>`;

  // Card grid
  const gridClass = variants.length <= 3 ? 'grid-3' : 'grid-4';
  html += `<div class="${gridClass}" id="grid">`;
  variants.forEach((node, i) => {
    const isReady = node.status === 'ready';
    const keyHint = variants.length <= 3 ? String.fromCharCode(97+i) : String(i+1);
    const params = node.params || {};
    const paramRows = Object.entries(params).map(([k,val]) =>
      `<div class="param-row"><span class="param-key">${k}</span>${val}</div>`).join('');
    const statusClass = node.status || 'pending';
    const clickAttr = `onclick="pick('${node.id}')"`;  // always attached; pick() guards on ready
    const artifact = node.artifact || node.image || '';

    let cardContent = '';
    if (artifactType === 'html') {
      cardContent = `<div class="card-embed-wrap">
        ${isReady ? `<iframe src="${artifact}" sandbox="allow-scripts" loading="lazy" title="${node.label}"></iframe>` :
          `<div class="card-placeholder"><div class="mini-spinner"></div><div class="placeholder-label">${node.status||'pending'}</div></div>`}
      </div>`;
    } else if (artifactType === 'audio') {
      cardContent = `<div class="card-audio-wrap">
        <div class="audio-icon">♪</div>
        ${isReady ? `<audio controls src="${artifact}"></audio>` :
          `<div class="card-placeholder"><div class="mini-spinner"></div><div class="placeholder-label">${node.status||'pending'}</div></div>`}
      </div>`;
    } else {
      cardContent = `<div class="card-img-wrap">
        ${isReady ? `<img src="${artifact}" alt="${node.label}" loading="eager">` :
          `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="">`}
        ${!isReady ? `<div class="card-placeholder">
          <div class="mini-spinner"></div>
          <div class="placeholder-label">${node.status||'pending'}</div>
        </div>` : ''}
      </div>`;
    }

    html += `<div class="card ${statusClass}" id="card-${node.id}" ${clickAttr}>
      ${cardContent}
      <div class="card-label">${node.label} <span style="opacity:.5;font-size:.65rem">${isReady?'':'…'}</span></div>
      ${node.mutation?`<div class="card-mutation ${mutClass(node.mutation)}">${node.mutation}</div>`:''}
      <div class="card-check"><svg viewBox="0 0 16 16"><polyline points="3,8 6.5,11.5 13,5"/></svg></div>
      ${paramRows&&isReady?`<div class="card-params">${paramRows}</div>`:''}
    </div>`;
  });
  html += '</div>';

  // Footer
  html += `<div class="footer">
    <div class="pick-display ${selected?'has-pick':''}" id="pick-display">
      ${selected
        ? `Selected: <span class="pick-value">${selected.toUpperCase()}</span>`
        : `Click a variant · or press ${variants.length<=3?'a / b / c':'1 / 2 / 3 / 4'} · Enter to confirm`}
    </div>
    ${round>0?`<button class="finalize-btn" onclick="finalize()">Finalize ✓</button>`:''}
    <button class="confirm-btn ${selected?'ready':''}" id="confirm-btn" onclick="confirmPick()">Confirm →</button>
  </div>`;

  document.getElementById('main-content').innerHTML = html;
  if (selected) document.getElementById('card-'+selected)?.classList.add('selected');
}

function renderDone() {
  const winnerId = state.winner;
  const w = (treeNodes && winnerId) ? treeNodes[winnerId] : null;
  document.getElementById('title').innerHTML = 'Selection <span>Locked</span>';
  document.getElementById('subtitle').textContent = 'Idea locked in.';
  const artifact = w ? (w.artifact || w.image || '') : '';
  let winnerMedia = '';
  if (w && artifact) {
    if (artifactType === 'html') {
      winnerMedia = `<iframe src="${artifact}" sandbox="allow-scripts" style="width:100%;max-width:480px;height:360px;border:2px solid var(--teal);border-radius:var(--radius)"></iframe>`;
    } else if (artifactType === 'audio') {
      winnerMedia = `<audio controls src="${artifact}" style="width:100%;max-width:320px"></audio>`;
    } else if (artifact) {
      winnerMedia = `<img src="${artifact}" alt="winner">`;
    }
  }
  document.getElementById('main-content').innerHTML = `<div class="done-panel visible">
    ${winnerMedia}
    <div class="done-title">${w?w.label:'Winner'} — Round ${w?w.round:0}</div>
    <div class="done-sub">${w&&w.params?Object.values(w.params).join(' · '):''}</div>
  </div>`;
}

function pick(id) {
  const node = treeNodes && treeNodes[id];
  if (!node || node.status !== 'ready') return;
  if (selected && selected !== id) document.getElementById('card-'+selected)?.classList.remove('selected');
  selected = id;
  document.getElementById('card-'+id)?.classList.add('selected');
  const d = document.getElementById('pick-display');
  if (d) { d.innerHTML = `Selected: <span class="pick-value">${id.toUpperCase()}</span>`; d.classList.add('has-pick'); }
  document.getElementById('confirm-btn')?.classList.add('ready');
}

async function goBack() {
  if (!state || (state.path||[]).length === 0) return;
  // Remove last item from path by picking the parent's parent (or clearing)
  // We do this by calling pick with the second-to-last path element's parent
  // Actually just reload after un-pick — send a POST to api/back if available,
  // otherwise refresh (server will serve current state)
  // Simple approach: reload status which reflects current path
  try {
    const r = await fetch('api/back', {method:'POST'});
    if (!r.ok) { showError('Back failed'); return; }
    selected = null;
    await loadStatus();
  } catch(e) { showError('Server error: '+e.message); }
}

async function confirmPick() {
  if (!selected || confirming) return;
  confirming = true;
  try {
    const r = await fetch('api/pick', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({node_id: selected}),
    });
    if (!r.ok) { showError('Pick failed: '+((await r.json()).error||r.status)); return; }
    selected = null;
    await loadStatus();
    startPolling();
  } catch(e) { showError('Server error: '+e.message); }
  finally { confirming = false; }
}

async function finalize() {
  try {
    await fetch('api/finalize', {method:'POST'});
    await loadStatus();
  } catch(e) { showError('Server error: '+e.message); }
}

async function loadStatus() {
  try {
    const [statusRes, treeRes] = await Promise.all([
      fetch('api/status'),
      treeNodes ? Promise.resolve(null) : fetch('api/tree'),
    ]);
    if (!statusRes.ok) throw new Error('HTTP '+statusRes.status);
    const data = await statusRes.json();
    state = data;
    if (treeRes) {
      if (!treeRes.ok) throw new Error('tree HTTP '+treeRes.status);
      treeNodes = await treeRes.json();
    } else {
      // Refresh tree nodes from status (they may have status updates)
      if (data.nodes) treeNodes = data.nodes;
    }
    if (data.artifact_type) artifactType = data.artifact_type;
    hideError();
    render();
    // Stop polling if everything is idle and all current variants are ready
    const variants = currentVariants() || [];
    const allReady = variants.length > 0 && variants.every(n => n.status === 'ready');
    const genIdle = data.gen_status === 'idle';
    if (genIdle && allReady) stopPolling();
  } catch(e) {
    showError('IDNA server offline — run: uv run idna_server.py');
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(loadStatus, 2000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function showError(msg) {
  const e = document.getElementById('error-bar');
  e.textContent = msg; e.classList.add('visible');
}
function hideError() {
  document.getElementById('error-bar').classList.remove('visible');
}

loadStatus();
startPolling();
</script>
</body>
</html>"""


# ── Hi-res winner re-generation ───────────────────────────────────────────────

def _regen_winner_hires(project: str, subject: str, winner_id: str) -> None:
    """Re-generate the winner image at full resolution after finalize."""
    sdir = _session_dir(project, subject)
    session = read_session(project, subject)
    node = session.get("nodes", {}).get(winner_id)
    if not node:
        log.error("Winner node %s not found", winner_id)
        return

    round_num = node["round"]
    hires_dir = sdir / "final"
    prompts_dir = hires_dir / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)

    # Write hi-res job file
    job = {
        "id": winner_id,
        "label": node["label"],
        "seed": node.get("seed", round_num * 100),
        "width": FINAL_WIDTH,
        "height": FINAL_HEIGHT,
        "prompt": node["prompt"],
    }
    (prompts_dir / f"{winner_id}.json").write_text(json.dumps(job, indent=2))

    generate_script = Path(__file__).parent / "idna_generate_round.py"
    log.info("Re-generating winner %s at %dx%d...", winner_id, FINAL_WIDTH, FINAL_HEIGHT)
    result = subprocess.run(
        ["uv", "run", "--project", str(IMAGECLI_PROJECT),
         "python", str(generate_script), str(hires_dir), "--steps", "40"],
        capture_output=False, text=True,
    )
    if result.returncode != 0:
        log.error("Hi-res re-gen failed (exit %d)", result.returncode)
        session = read_session(project, subject)
        session["phase"] = "error"
        session["error"] = "hi-res re-gen failed"
        write_session(project, subject, session)
        return

    hires_path = f"final/{winner_id}.png"
    session = read_session(project, subject)
    session["winner_hires"] = hires_path
    session["phase"] = "done"
    write_session(project, subject, session)
    log.info("Winner hi-res ready: %s", hires_path)


# ── HTTP handler ──────────────────────────────────────────────────────────────

MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
    ".html": "text/html", ".json": "application/json",
}


class IDNAHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass  # suppress default access log

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data) -> None:
        self._send(code, json.dumps(data).encode(), "application/json")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        project, subject, rest = _parse_path(path)

        if project is None:
            body = _index_html(discover_sessions()).encode()
            self._send(200, body, "text/html; charset=utf-8")
            return

        sdir = _session_dir(project, subject)

        if rest in ("/", ""):
            self._send(200, PICKER_HTML.encode(), "text/html; charset=utf-8")
            return

        if rest == "/api/status":
            session = read_session(project, subject)
            if not _is_new_format(session):
                self._json(200, {"error": "legacy format", "gen_status": "legacy",
                                  "phase": "legacy", "path": [], "nodes": {}, "queue_length": 0})
                return
            payload = {
                "id": session.get("id"),
                "template": session.get("template", "avatar"),
                "artifact_type": _get_artifact_type(session),
                "phase": session.get("phase", "picking"),
                "gen_status": session.get("gen_status", "idle"),
                "path": session.get("path", []),
                "winner": session.get("winner"),
                "queue_length": len(session.get("queue", [])),
                "nodes": session.get("nodes", {}),
            }
            self._json(200, payload)
            return

        if rest == "/api/tree":
            session = read_session(project, subject)
            if not _is_new_format(session):
                self._json(200, {})
                return
            self._json(200, session.get("nodes", {}))
            return

        # Static files (images)
        file_path = sdir / rest.lstrip("/")
        if file_path.exists() and file_path.is_file():
            ext = file_path.suffix.lower()
            mime = MIME.get(ext, "application/octet-stream")
            self._send(200, file_path.read_bytes(), mime)
        else:
            self._json(404, {"error": f"not found: {rest}"})

    def do_POST(self):
        path = self.path.split("?")[0]

        # ── Root-level API ────────────────────────────────────────────────────
        if path == "/api/new":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            project  = (body.get("project") or "").strip().lower().replace(" ", "-")
            subject  = (body.get("subject") or "").strip().lower().replace(" ", "-")
            intent   = (body.get("intent") or "").strip()
            depth    = int(body.get("depth", 3))
            width    = int(body.get("width", 4))
            template = (body.get("template") or "").strip() or None

            if not project or not subject or not intent:
                self._json(400, {"error": "project, subject, and intent are required"})
                return

            sdir = _session_dir(project, subject)
            if (sdir / "session.json").exists():
                sess = json.loads((sdir / "session.json").read_text())
                if sess.get("vocabulary"):
                    self._json(409, {"error": f"session {project}/{subject} already exists", "url": f"/{project}/{subject}/"})
                    return

            sdir.mkdir(parents=True, exist_ok=True)
            server_dir = Path(__file__).parent

            # SSE streaming response
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            def emit(data: dict):
                line = "data: " + json.dumps(data) + "\n\n"
                self.wfile.write(line.encode())
                self.wfile.flush()

            # Step 1 — vocabulary (1 LLM call)
            emit({"step": "vocabulary", "status": "running", "message": "Designing your selector with Claude\u2026"})
            setup_args = [
                sys.executable, str(server_dir / "idna_setup.py"),
                str(sdir), f"--depth={depth}", f"--width={width}", f"--intent={intent}",
            ]
            if template:
                setup_args.append(f"--template={template}")
            result = subprocess.run(setup_args, capture_output=True, text=True, timeout=180)
            if result.returncode != 0:
                emit({"step": "vocabulary", "status": "error", "message": result.stderr.strip()})
                return
            try:
                sess = json.loads((sdir / "session.json").read_text())
                n_poles = len(sess.get("vocabulary", {}).get("poles", []))
            except Exception:
                n_poles = 0
            emit({"step": "vocabulary", "status": "done", "message": f"Vocabulary ready \u2014 {n_poles} poles"})

            # Step 2 — tree (pure script)
            emit({"step": "tree", "status": "running", "message": "Building exploration tree\u2026"})
            result = subprocess.run(
                [sys.executable, str(server_dir / "idna_build_tree.py"), str(sdir), f"--depth={depth}"],
                capture_output=True, text=True, timeout=60,
            )
            if result.returncode != 0:
                emit({"step": "tree", "status": "error", "message": result.stderr.strip()})
                return
            try:
                sess = json.loads((sdir / "session.json").read_text())
                n_nodes = len(sess.get("nodes", {}))
            except Exception:
                n_nodes = 0
            emit({"step": "tree", "status": "done", "message": f"{n_nodes} nodes built"})

            sess = json.loads((sdir / "session.json").read_text())
            template_name = sess.get("template", "")

            if template_name in ("avatar", "logo"):
                # Step 3 — encode all prompts (text encoder only, one pass for all nodes)
                _kill_stale_imagecli()
                emit({"step": "encode", "status": "running", "message": "Loading text encoder\u2026"})
                encode_script = server_dir / "idna_encode_all.py"
                enc_proc = subprocess.Popen(
                    ["uv", "run", "--project", str(Path.home() / "projects/imageCLI"),
                     "python", str(encode_script), str(sdir)],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, bufsize=1,
                )
                for line in enc_proc.stdout:
                    line = line.strip()
                    if line:
                        emit({"step": "encode", "status": "running", "message": line})
                enc_proc.wait()
                if enc_proc.returncode != 0:
                    emit({"step": "encode", "status": "error", "message": "Encode failed"})
                    return
                emit({"step": "encode", "status": "done", "message": "All prompts encoded"})

                # Step 4 — generate round 0 (transformer + VAE only, embeds cached)
                _kill_stale_imagecli()
                emit({"step": "generate", "status": "running", "message": "Loading FLUX into VRAM\u2026"})
                gen_script = server_dir / "idna_generate_round.py"
                round0_dir = sdir / "round_0"
                gen_proc = subprocess.Popen(
                    ["uv", "run", "--project", str(Path.home() / "projects/imageCLI"),
                     "python", str(gen_script), str(round0_dir), "--steps", "15"],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, bufsize=1,
                )
                for line in gen_proc.stdout:
                    line = line.strip()
                    if line:
                        emit({"step": "generate", "status": "running", "message": line})
                gen_proc.wait()
                if gen_proc.returncode != 0:
                    emit({"step": "generate", "status": "error", "message": "Round 0 generation failed"})
                    return
                # Mark round 0 nodes ready
                sess = read_session(project, subject)
                w = sess.get("width", 4)
                for nid in [f"v{i}" for i in range(w)]:
                    if nid in sess.get("nodes", {}):
                        sess["nodes"][nid]["status"] = "ready"
                write_session(project, subject, sess)
                emit({"step": "generate", "status": "done", "message": "Round 0 ready"})

            # Start background worker for remaining rounds
            _ensure_worker(project, subject)

            emit({"step": "ready", "status": "done", "url": f"/{project}/{subject}/", "message": "Ready!"})
            return

        project, subject, rest = _parse_path(path)

        if project is None:
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if rest == "/api/pick":
            node_id = body.get("node_id")
            if not node_id:
                self._json(400, {"error": "node_id required"})
                return

            session = read_session(project, subject)
            if not _is_new_format(session):
                self._json(422, {"error": "legacy session format — rebuild tree first"})
                return

            nodes = session.get("nodes", {})
            if node_id not in nodes:
                self._json(404, {"error": f"node {node_id!r} not found"})
                return

            node = nodes[node_id]
            if node.get("status") != "ready":
                self._json(409, {"error": f"node {node_id!r} not ready (status: {node.get('status')})"})
                return

            # Add to path
            path_list = session.get("path", [])
            expected_round = len(path_list)
            if node["round"] != expected_round:
                self._json(409, {"error": f"node round {node['round']} != expected {expected_round}"})
                return

            path_list.append(node_id)
            session["path"] = path_list

            # Priority boost: move children of picked node to front of remaining queue
            children = _node_children_ids(node_id)
            queue = session.get("queue", [])
            # Remove children from wherever they are in queue
            remaining = [nid for nid in queue if nid not in children]
            # Find first index of next round items
            next_round = node["round"] + 1
            insert_at = 0
            for i, qid in enumerate(remaining):
                if nodes.get(qid, {}).get("round", 0) == next_round:
                    insert_at = i
                    break
                if nodes.get(qid, {}).get("round", 0) > next_round:
                    insert_at = i
                    break
                insert_at = i + 1
            # Insert children at the front of their round's section
            for c in reversed(children):
                if c in nodes:
                    remaining.insert(insert_at, c)
            session["queue"] = remaining

            write_session(project, subject, session)

            # Ensure generation worker is running
            _ensure_worker(project, subject)

            self._json(200, {"ok": True, "picked": node_id, "path": path_list})

        elif rest == "/api/back":
            session = read_session(project, subject)
            if not _is_new_format(session):
                self._json(422, {"error": "legacy format"})
                return
            path_list = session.get("path", [])
            if not path_list:
                self._json(400, {"error": "path is already empty"})
                return
            path_list.pop()
            session["path"] = path_list
            write_session(project, subject, session)
            self._json(200, {"ok": True, "path": path_list})

        elif rest == "/api/finalize":
            session = read_session(project, subject)
            if not _is_new_format(session):
                self._json(422, {"error": "legacy format"})
                return
            path_list = session.get("path", [])
            if not path_list:
                self._json(400, {"error": "no picks yet — pick at least one node first"})
                return
            winner_id = path_list[-1]
            session["winner"] = winner_id
            session["phase"] = "finalizing"
            write_session(project, subject, session)
            # Kick off hi-res re-generation of winner in background
            t = threading.Thread(
                target=_regen_winner_hires,
                args=(project, subject, winner_id),
                daemon=True,
            )
            t.start()
            self._json(200, {"ok": True, "winner": winner_id, "regenerating": True})

        else:
            self._json(404, {"error": "not found"})


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8082
    server = HTTPServer(("localhost", port), IDNAHandler)
    log.info("IDNA server on http://localhost:%d/", port)
    log.info("Sessions root: %s", IDNA_DIR)
    sessions = discover_sessions()
    for s in sessions:
        gen_s = s.get("gen_status", s.get("status", "?"))
        log.info("  %s/%s [%s]", s["project"], s["subject"], gen_s)
        # Auto-resume generation worker for active sessions
        if gen_s == "generating":
            project = s["project"]
            subject = s["subject"]
            log.info("  Resuming generation worker for %s/%s", project, subject)
            _ensure_worker(project, subject)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Stopped.")


if __name__ == "__main__":
    main()
