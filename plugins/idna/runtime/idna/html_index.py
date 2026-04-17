"""Index page HTML generator — lists all sessions."""

from __future__ import annotations

import html as _html

from .html_index_css import INDEX_CSS
from .html_index_js import INDEX_JS

_STATUS_COLOR: dict[str, str] = {
    "generating": "#e8a030", "encoding": "#a78bfa", "building": "#22d3ee",
    "idle": "#34d399", "done": "#20c9ac", "error": "#f87171",
    "ready": "#22d3ee", "finalizing": "#a78bfa", "locked": "#20c9ac",
}


def _index_html(sessions: list[dict], daemon_ok: bool = True) -> str:
    daemon_banner = "" if daemon_ok else (
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;padding:10px 16px;'
        'background:rgba(220,80,60,.12);border:1px solid rgba(220,80,60,.4);border-radius:8px;'
        'font-size:.78rem;color:#e05040">'
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#e05040" stroke-width="2" style="flex-shrink:0">'
        '<circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="8"/><line x1="8" y1="11" x2="8.01" y2="11"/>'
        '</svg>&nbsp;imageCLI daemon offline &mdash; run '
        '<code style="font-family:monospace;background:rgba(0,0,0,.3);padding:1px 5px;border-radius:3px;margin:0 4px">'
        'make gen start</code> to generate images</div>'
    )
    _e = _html.escape
    cards = ""
    for s in sessions:
        phase = s.get("phase", "picking")
        gen_status = s.get("gen_status", "unknown")
        label = phase if phase in ("done", "finalizing") else (gen_status or s.get("status", "unknown"))
        color = _STATUS_COLOR.get(label, "#7d8799")
        display_img = s.get("display_img")
        thumb = f'<img src="{_e(display_img)}" alt="preview">' if display_img else ""
        ratio = _e(s.get("ratio", "3:4"))
        ratio_css = ratio.replace(":", "/")
        tmpl = _e(s.get("template", ""))
        cards += f"""
    <a class="card" href="{_e(s['url'])}">
      <div class="card-thumb" style="aspect-ratio:{ratio_css}">{thumb}</div>
      <div class="card-body">
        <div class="card-project">{_e(s['project'])}</div>
        <div class="card-subject">{_e(s['subject'])}</div>
        <div class="card-meta">
          <span class="badge" style="border-color:{color};color:{color}">{_e(label)}</span>
          <span class="dim">r{s['round']} \u00b7 {ratio}{' \u00b7 ' + tmpl if tmpl else ''}</span>
        </div>
      </div>
    </a>"""
    empty = (
        '<div class="empty">No sessions yet. Hit <strong>+ New</strong> to start one.</div>'
        if not sessions else ""
    )
    return f"""<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IDNA \u2014 Idea DNA</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>{INDEX_CSS}</style>
</head>
<body>
<div class="layout">
  <div class="header">
    <div class="header-text">
      <div class="mono">IDNA / Idea DNA</div>
      <h1>Evolutionary <span>Selectors</span></h1>
      <div class="sub">Active sessions \u2014 click to open picker</div>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <div class="size-ctrl">
        <button class="size-btn" onclick="resizeCards(-40)">\u2212</button>
        <span class="size-label" id="sizeLabel">220</span>
        <button class="size-btn" onclick="resizeCards(+40)">+</button>
      </div>
      <button class="btn-new" onclick="openModal()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New selector
      </button>
    </div>
  </div>
  {daemon_banner}
  <div class="grid">{cards}</div>
  {empty}
</div>

<div class="overlay" id="overlay" onclick="maybeClose(event)">
  <div class="modal" id="modal">
    <h2>New <span>Selector</span></h2>
    <div class="mode-toggle">
      <button class="mode-btn" id="mode-prompt" onclick="setMode('prompt')">Custom vocabulary</button>
      <button class="mode-btn active" id="mode-random" onclick="setMode('random')">Random</button>
    </div>
    <div class="row">
      <div class="field">
        <label>Project</label>
        <input id="f-project" placeholder="lyra" autocomplete="off">
        <span class="field-err" id="err-project"></span>
      </div>
      <div class="field">
        <label>Subject</label>
        <input id="f-subject" placeholder="avatar" autocomplete="off">
        <span class="field-err" id="err-subject"></span>
      </div>
    </div>
    <div class="field" id="field-intent" style="display:none">
      <label>What do you want to select?</label>
      <textarea id="f-intent" placeholder="e.g. brand color palette for a dark SaaS dashboard \u2014 warm, modern, accessible"></textarea>
      <span class="field-err" id="err-intent"></span>
    </div>
    <div class="field" id="field-anchor">
      <label>Subject anchor <span style="opacity:.5;font-size:.78rem">(optional)</span></label>
      <input id="f-anchor" placeholder="e.g. a young woman, warm friendly style" autocomplete="off">
    </div>
    <div class="row">
      <div class="field">
        <label id="template-label">Template <span id="template-required" style="font-size:.78rem">(required)</span></label>
        <select id="f-template">
          <option value="" id="template-auto" disabled>\u2014 auto-detect \u2014</option>
          <option value="avatar" selected>Avatar / persona</option>
          <option value="logo">Logo concept</option>
        </select>
        <span class="field-err" id="err-template"></span>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Width</label>
        <select id="f-width">
          <option value="3">3 variants</option>
          <option value="4" selected>4 variants</option>
          <option value="5">5 variants</option>
          <option value="6">6 variants</option>
          <option value="7">7 variants</option>
          <option value="8">8 variants</option>
          <option value="9">9 variants</option>
        </select>
      </div>
      <div class="field">
        <label>Aspect Ratio</label>
        <select id="f-ratio">
          <option value="1:1">1:1 \u2014 Square</option>
          <option value="3:4" selected>3:4 \u2014 Portrait</option>
          <option value="9:16">9:16 \u2014 Tall</option>
          <option value="4:3">4:3 \u2014 Landscape</option>
          <option value="16:9">16:9 \u2014 Wide</option>
        </select>
      </div>
    </div>
    <div class="steps" id="steps-ui" style="display:none">
      <div class="step" id="step-vocabulary"><span class="step-icon">&#9679;</span><div><div>Vocabulary</div><div class="step-detail" id="detail-vocabulary">Designing your selector with Claude</div></div></div>
      <div class="step" id="step-tree"><span class="step-icon">&#9679;</span><div><div>Tree</div><div class="step-detail" id="detail-tree">Building exploration tree</div></div></div>
      <div class="step" id="step-encode"><span class="step-icon">&#9679;</span><div><div>Encode</div><div class="step-detail" id="detail-encode">Text encoder \u2014 waiting\u2026</div></div></div>
      <div class="step" id="step-generate"><span class="step-icon">&#9679;</span><div><div>Generate round 0</div><div class="step-detail" id="detail-generate">FLUX \u2014 first images</div></div></div>
      <div class="step" id="step-ready"><span class="step-icon">&#9679;</span><div><div>Ready</div><div class="step-detail" id="detail-ready">Opening picker</div></div></div>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-create" id="btn-create" onclick="createSession()">Create</button>
    </div>
  </div>
</div>

<script>{INDEX_JS}</script>
</body>
</html>"""
