"""CSS for the IDNA picker page."""

PICKER_CSS = """
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
.menu-wrap{position:relative}
.menu-btn{background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text-dim);cursor:pointer;font-size:1.1rem;line-height:1;padding:4px 10px;letter-spacing:.05em}
.menu-btn:hover{border-color:var(--border2);color:var(--text)}
.menu-dropdown{display:none;position:absolute;right:0;top:calc(100% + 6px);background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:6px;min-width:160px;z-index:100;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.menu-wrap.open .menu-dropdown{display:flex;flex-direction:column;gap:2px}
.menu-item{background:none;border:none;border-radius:7px;color:var(--text-dim);cursor:pointer;font-family:var(--font);font-size:.82rem;padding:8px 12px;text-align:left;width:100%}
.menu-item:hover{background:var(--border);color:var(--text)}
.menu-item.danger{color:#f87171}
.menu-item.danger:hover{background:rgba(248,113,113,.1);color:#f87171}
.menu-confirm{display:none;flex-direction:column;gap:4px;padding:8px}
.menu-confirm.visible{display:flex}
.menu-confirm-msg{font-size:.78rem;color:var(--text-dim);padding:0 2px 4px}
.menu-confirm-btns{display:flex;gap:6px}
.menu-confirm-btns button{flex:1;border-radius:6px;border:1px solid var(--border2);cursor:pointer;font-size:.78rem;padding:5px 8px}
.menu-confirm-cancel{background:var(--surface);color:var(--text-dim)}
.menu-confirm-ok{background:#f87171;border-color:#f87171;color:#fff;font-weight:600}
.size-ctrl{display:flex;align-items:center;gap:3px}
.size-btn{background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text-dim);cursor:pointer;font-family:var(--mono);font-size:.9rem;font-weight:700;padding:3px 9px;line-height:1;transition:border-color .15s,color .15s}
.size-btn:hover{border-color:var(--accent);color:var(--accent)}
.size-label{font-family:var(--mono);font-size:.72rem;color:var(--text-dim);min-width:26px;text-align:center}
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
.grid-4,.grid-3{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--card-w,220px),1fr));gap:14px;margin-bottom:24px}
@media(max-width:640px){.grid-4,.grid-3{grid-template-columns:1fr}}
.card{position:relative;border-radius:var(--radius);border:2px solid var(--border);background:var(--surface);overflow:hidden;cursor:pointer;transition:border-color .18s,transform .15s,box-shadow .18s;user-select:none}
.card:hover{border-color:var(--border2);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.35)}
.card.selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),0 8px 32px rgba(232,160,48,.25)}
.card.selected::after{content:'';position:absolute;inset:0;border-radius:calc(var(--radius) - 2px);background:rgba(232,160,48,.06);pointer-events:none}
.card.not-ready{cursor:default}
.card.not-ready:hover{transform:none;border-color:var(--border)}
.card-img-wrap{position:relative;width:100%;aspect-ratio:var(--card-ratio,3/4);background:#0a0c14;overflow:hidden}
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
.card-parent{border-color:var(--teal)!important;opacity:.85}
.card-parent:hover{border-color:var(--teal)!important;opacity:1}
.card-keep-badge{position:absolute;top:10px;right:10px;font-size:.65rem;font-family:var(--mono);padding:2px 7px;border-radius:4px;border:1px solid rgba(32,201,172,.5);background:rgba(32,201,172,.15);color:var(--teal);font-weight:700;z-index:3}
.card-mutation{position:absolute;top:10px;right:10px;font-size:.65rem;font-family:var(--mono);padding:2px 7px;border-radius:4px;border:1px solid;font-weight:700;z-index:2}
.mut-amplify{color:#f97316;border-color:rgba(249,115,22,.4);background:rgba(249,115,22,.15)}
.mut-blend{color:#a78bfa;border-color:rgba(167,139,250,.4);background:rgba(167,139,250,.15)}
.mut-refine{color:#34d399;border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.15)}
.mut-axis{color:#22d3ee;border-color:rgba(34,211,238,.4);background:rgba(34,211,238,.12)}
.nudge-bar{display:none;align-items:center;gap:8px;margin-bottom:16px;padding:9px 12px;background:var(--surface);border:1px solid rgba(34,211,238,.35);border-radius:8px}
.nudge-bar input{flex:1;background:transparent;border:none;outline:none;color:var(--text);font-family:var(--font);font-size:.85rem;min-width:0}
.nudge-bar input::placeholder{color:var(--text-xdim)}
.nudge-btn{padding:5px 14px;background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.4);border-radius:6px;color:var(--teal);font-family:var(--font);font-size:.8rem;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:background .15s}
.nudge-btn:hover{background:var(--teal);color:#0c0e16}
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
.daemon-warn{display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:10px 16px;background:rgba(220,80,60,.12);border:1px solid rgba(220,80,60,.4);border-radius:8px;font-size:.78rem;color:#e05040}
.daemon-warn svg{width:16px;height:16px;flex-shrink:0;stroke:#e05040;fill:none;stroke-width:2}
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
"""
