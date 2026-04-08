"""CSS for the IDNA index page."""

INDEX_CSS = """
:root{--bg:#0c0e16;--surface:#13161f;--border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
  --text:#dde4f0;--text-dim:#7d8799;--accent:#e8a030;--teal:#22d3ee;
  --font:'Plus Jakarta Sans',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;--radius:12px}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:15px;-webkit-font-smoothing:antialiased}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;padding:40px 24px 80px}
.layout{max-width:1600px;margin:0 auto}
.header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:36px;flex-wrap:wrap}
.header-text .mono{font-family:var(--mono);font-size:.72rem;color:var(--teal);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
h1{font-size:1.8rem;font-weight:700;letter-spacing:-.02em}
h1 span{color:var(--accent)}
.sub{font-size:.85rem;color:var(--text-dim);margin-top:6px}
.btn-new{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;background:var(--accent);color:#0c0e16;
  border:none;border-radius:8px;font-family:var(--font);font-size:.9rem;font-weight:700;cursor:pointer;
  transition:opacity .15s;white-space:nowrap;align-self:center}
.btn-new:hover{opacity:.88}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--card-w,220px),1fr));gap:16px}
.size-ctrl{display:flex;align-items:center;gap:4px}
.size-btn{background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text-dim);cursor:pointer;font-family:var(--mono);font-size:.9rem;font-weight:700;padding:3px 10px;line-height:1;transition:border-color .15s,color .15s}
.size-btn:hover{border-color:var(--accent);color:var(--accent)}
.size-label{font-family:var(--mono);font-size:.72rem;color:var(--text-dim);min-width:28px;text-align:center}
.card{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius);
  background:var(--surface);overflow:hidden;text-decoration:none;color:inherit;
  transition:border-color .18s,transform .15s}
.card:hover{border-color:var(--border2);transform:translateY(-2px)}
.card-thumb{width:100%;background:#0a0c14;overflow:hidden;display:flex;align-items:center;justify-content:center}
.card-thumb img{width:100%;height:100%;object-fit:cover}
.card-thumb:empty::after{content:'No image yet';font-family:var(--mono);font-size:.7rem;color:var(--text-dim)}
.card-body{padding:14px}
.card-project{font-family:var(--mono);font-size:.68rem;color:var(--teal);text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px}
.card-subject{font-size:1rem;font-weight:600;margin-bottom:10px}
.card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge{font-family:var(--mono);font-size:.65rem;padding:2px 7px;border-radius:4px;border:1px solid;font-weight:600}
.dim{font-family:var(--mono);font-size:.68rem;color:var(--text-dim)}
.empty{color:var(--text-dim);font-size:.9rem;padding:40px 0;text-align:center}
.empty strong{color:var(--accent)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);display:flex;
  align-items:center;justify-content:center;z-index:100;opacity:0;pointer-events:none;transition:opacity .2s}
.overlay.open{opacity:1;pointer-events:all}
.modal{background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:28px;
  width:min(520px,calc(100vw - 32px));display:flex;flex-direction:column;gap:20px}
.modal h2{font-size:1.2rem;font-weight:700}
.modal h2 span{color:var(--accent)}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:.8rem;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em}
.field input,.field textarea,.field select{background:#0a0c14;border:1px solid var(--border2);border-radius:8px;
  color:var(--text);font-family:var(--font);font-size:.95rem;padding:10px 12px;outline:none;
  transition:border-color .15s;width:100%}
.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--accent)}
.field textarea{min-height:90px;resize:vertical;line-height:1.5}
.field select option{background:#13161f}
.field-err{font-size:.75rem;color:#f87171;min-height:.9em;margin-top:-2px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.mode-toggle{display:flex;gap:4px;background:var(--bg);border:1px solid var(--border2);border-radius:8px;padding:3px;margin-bottom:18px;width:fit-content}
.mode-btn{background:none;border:none;border-radius:6px;color:var(--text-dim);cursor:pointer;font-family:var(--font);font-size:.82rem;font-weight:500;padding:6px 16px;transition:background .15s,color .15s}
.mode-btn.active{background:var(--surface);color:var(--text);box-shadow:0 1px 4px rgba(0,0,0,.3)}
.modal-footer{display:flex;gap:10px;justify-content:flex-end}
.btn-cancel{padding:9px 18px;background:transparent;border:1px solid var(--border2);border-radius:8px;
  color:var(--text-dim);font-family:var(--font);font-size:.9rem;cursor:pointer;transition:border-color .15s}
.btn-cancel:hover{border-color:var(--text-dim)}
.btn-create{padding:9px 22px;background:var(--accent);border:none;border-radius:8px;
  color:#0c0e16;font-family:var(--font);font-size:.9rem;font-weight:700;cursor:pointer;transition:opacity .15s}
.btn-create:hover{opacity:.88}
.btn-create:disabled{opacity:.45;cursor:not-allowed}
.steps{display:flex;flex-direction:column;gap:8px}
.step{display:flex;align-items:center;gap:10px;font-size:.88rem;opacity:.35;transition:opacity .2s}
.step.active{opacity:1}.step.done{opacity:.7}.step.error{opacity:1;color:#f87171}
.step-icon{width:18px;height:18px;flex-shrink:0}
.step-spinner{width:18px;height:18px;border:2px solid rgba(255,255,255,.15);border-top-color:var(--teal);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
.step-detail{font-size:.75rem;color:var(--text-dim);font-family:var(--mono);margin-top:2px}
@keyframes spin{to{transform:rotate(360deg)}}
"""
