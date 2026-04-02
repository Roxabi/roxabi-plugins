# Split-File Pattern

Multi-tab explainers use four file groups relative to the diagram root:

```
<name>.html              — shell: head, nav, empty panel placeholders
css/<name>.css           — all styles
js/<name>.js             — loadPanel + tab switching + theme toggle
tabs/<name>/
  tab-<id>.html          — one fragment per tab (lazy-loaded, no DOCTYPE/html/body)
```

## Output Paths

| Context | Path |
|---------|------|
| Exploration / iteration | `~/.roxabi/forge/<project>/visuals/` |
| Final / canonical | `~/projects/<project>/docs/visuals/` |

Both share the same `css/`, `js/`, `tabs/` structure relative to the `.html` shell.

## Version Isolation

Each version owns its own tabs subdirectory. **Never share `tabs/` between versions.**

```
tabs/v7/tab-overview.html
tabs/v8/tab-overview.html   ← isolated; slug may match but content differs
```

For topic-named diagrams (not versioned), use `tabs/<name>/tab-<id>.html`.

---

## Shell HTML Template

```html
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{TITLE}</title>
  <!-- diagram-meta:start -->
  <meta name="diagram:title"     content="{TITLE}">
  <meta name="diagram:date"      content="{YYYY-MM-DD}">
  <meta name="diagram:category"  content="{category}">
  <meta name="diagram:cat-label" content="{Label}">
  <meta name="diagram:color"     content="{color}">
  <meta name="diagram:badges"    content="latest">
  <!-- diagram-meta:end -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/{NAME}.css">
</head>
<body>
  <nav class="topnav">
    <span class="nav-title">{TITLE}</span>
    <div class="tabs" role="tablist">
      <button class="tab-btn" data-tab="{ID1}" role="tab">{LABEL1}</button>
      <!-- repeat per tab -->
    </div>
    <button class="theme-btn" id="theme-toggle">◑ light</button>
  </nav>
  <main>
    <div class="panel" data-panel="{ID1}" role="tabpanel"></div>
    <!-- repeat per tab -->
  </main>
  <script src="js/{NAME}.js"></script>
</body>
</html>
```

---

## CSS Skeleton

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }

/* ── Tokens ── (insert from references/tokens.md) ───────────── */
:root, [data-theme="dark"] {
  --bg:         #0a0a0f;
  --surface:    #18181f;
  --border:     #2a2a35;
  --text:       #fafafa;
  --text-muted: #9ca3af;
  --text-dim:   #6b7280;
  --accent:     #e85d04;
  --accent-dim: #7c2d0e;
}
[data-theme="light"] {
  --bg:         #fafaf9;
  --surface:    #f4f4f0;
  --border:     #d1ccc7;
  --text:       #1c1917;
  --text-muted: #57534e;
  --text-dim:   #78716c;
  --accent:     #c2410c;
  --accent-dim: #fef2e8;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  line-height: 1.6;
  min-height: 100vh;
}

/* ── Nav ─────────────────────────────────────────────────────── */
.topnav {
  position: sticky; top: 0; z-index: 100;
  display: flex; align-items: center; gap: 1rem;
  padding: 0 1.5rem; height: 3rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.nav-title {
  font-size: 0.875rem; font-weight: 600;
  color: var(--text); margin-right: auto; white-space: nowrap;
}
.tabs { display: flex; gap: 0.25rem; }
.tab-btn {
  padding: 0.375rem 0.875rem; font-size: 0.8125rem;
  font-family: inherit; font-weight: 500;
  color: var(--text-dim); background: transparent;
  border: none; border-radius: 4px; cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.tab-btn:hover  { color: var(--text-muted); background: var(--bg); }
.tab-btn.active { color: var(--accent);     background: var(--bg); }
.theme-btn {
  padding: 0.25rem 0.5rem; font-size: 0.75rem;
  color: var(--text-dim); background: transparent;
  border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
}
.theme-btn:hover { color: var(--text-muted); }

/* ── Panels ──────────────────────────────────────────────────── */
.panel { display: none; padding: 2rem 1.5rem; max-width: 960px; margin: 0 auto; }
.panel.active { display: block; }

/* ── Typography ──────────────────────────────────────────────── */
h1, h2, h3, h4 { color: var(--text); font-weight: 600; }
h1 { font-size: 1.75rem; margin-bottom: 0.75rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 0.75rem; }
h3 { font-size: 1rem;    margin: 1.5rem 0 0.5rem; }
p  { color: var(--text-muted); margin-bottom: 0.875rem; }
ul, ol { color: var(--text-muted); padding-left: 1.5rem; margin-bottom: 0.875rem; }
li { margin-bottom: 0.25rem; }
code {
  font-family: 'IBM Plex Mono', monospace; font-size: 0.875em;
  background: var(--surface); border: 1px solid var(--border);
  padding: 0.125em 0.35em; border-radius: 3px; color: var(--text);
}
pre {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; padding: 1rem; overflow-x: auto; margin-bottom: 1rem;
}
pre code {
  background: none; border: none; padding: 0;
  font-size: 0.875rem; white-space: pre-wrap;
}

/* ── Cards ───────────────────────────────────────────────────── */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1rem; margin-bottom: 1.5rem;
}
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 1.25rem;
}
.card.accent { border-left: 3px solid var(--accent); }
.card-label {
  font-size: 0.6875rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--accent); margin-bottom: 0.5rem;
}
.card-title {
  font-size: 0.9375rem; font-weight: 600;
  color: var(--text); margin-bottom: 0.375rem;
}
.card-body { font-size: 0.875rem; color: var(--text-muted); }

/* ── Tables ──────────────────────────────────────────────────── */
.table-wrap {
  overflow-x: auto; margin-bottom: 1.5rem;
  border: 1px solid var(--border); border-radius: 6px;
}
table { width: 100%; border-collapse: collapse; }
thead th {
  background: var(--surface); color: var(--text-dim);
  font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.06em;
  padding: 0.5rem 0.75rem; text-align: left;
  border-bottom: 1px solid var(--border);
  position: sticky; top: 3rem;
}
tbody td {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted); font-size: 0.875rem;
}
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: var(--surface); }

/* ── Responsive ──────────────────────────────────────────────── */
@media (max-width: 768px) {
  .topnav { padding: 0 1rem; flex-wrap: wrap; height: auto; padding-block: 0.5rem; }
  .tabs { overflow-x: auto; width: 100%; }
  .panel { padding: 1.5rem 1rem; }
}
```

---

## JS Skeleton

Replace **`{NAME}`** with the diagram's kebab-case filename slug (without `.html`).

```javascript
;(function () {
  // ── Theme ────────────────────────────────────────────────────
  var THEME_KEY = 'diag-{NAME}-theme'
  var saved = localStorage.getItem(THEME_KEY) || 'dark'
  document.documentElement.setAttribute('data-theme', saved)
  var themeBtn = document.getElementById('theme-toggle')
  if (themeBtn) {
    themeBtn.textContent = saved === 'dark' ? '◑ light' : '◑ dark'
    themeBtn.addEventListener('click', function () {
      var cur  = document.documentElement.getAttribute('data-theme')
      var next = cur === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      localStorage.setItem(THEME_KEY, next)
      this.textContent = next === 'dark' ? '◑ light' : '◑ dark'
    })
  }

  // ── Tabs ─────────────────────────────────────────────────────
  function loadPanel (id) {
    var panel = document.querySelector('[data-panel="' + id + '"]')
    if (!panel || panel._loaded) return
    fetch('tabs/{NAME}/tab-' + id + '.html')
      .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status) })
      .then(function (html) {
        panel.innerHTML = html
        panel._loaded = true
        if (typeof window.__postLoad === 'function') window.__postLoad(id, panel)
      })
      .catch(function (e) {
        panel.innerHTML = '<p style="padding:2rem;color:var(--text-muted)">Failed to load (' + e + ')</p>'
      })
  }

  function activate (id) {
    document.querySelectorAll('[data-tab]').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === id)
    })
    document.querySelectorAll('[data-panel]').forEach(function (p) {
      p.classList.toggle('active', p.dataset.panel === id)
    })
    loadPanel(id)
  }

  document.querySelectorAll('[data-tab]').forEach(function (t) {
    t.addEventListener('click', function () { activate(t.dataset.tab) })
  })

  var first = document.querySelector('[data-tab]')
  if (first) activate(first.dataset.tab)
})()
```

### Adding Mermaid support (optional)

If any tab will contain a Mermaid diagram, add before the `activate(first.dataset.tab)` line:

```javascript
  // ── Mermaid (only if tabs use it) ────────────────────────────
  window.__postLoad = async function (id, panel) {
    var srcEl     = panel.querySelector('[data-mermaid]')
    var container = panel.querySelector('[data-mermaid-out]')
    if (!srcEl || !container) return
    var { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
    mermaid.initialize({
      startOnLoad: false, theme: 'base',
      flowchart: { useMaxWidth: false, curve: 'basis' }
    })
    var { svg, bindFunctions } = await mermaid.render('mermaid-' + id, srcEl.textContent.trim())
    container.innerHTML = svg
    if (bindFunctions) bindFunctions(container.querySelector('svg'))
    if (typeof window.__initPanZoom === 'function') window.__initPanZoom(container)
  }
```

And in `<head>` of the shell HTML:
```html
<script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.2/dist/svg-pan-zoom.min.js"></script>
```

See `references/mermaid-guide.md` for the full `__initPanZoom` implementation and Mermaid checklist.

---

## Serving

Split-file diagrams use `fetch()` → **must be served over HTTP**, never `file://`.

```bash
# Full gallery (all projects) — diagrams supervisord program on :8080
# http://localhost:8080/

# Standalone (single diagram, no gallery needed):
cd ~/.roxabi/forge/<project>/visuals && python3 -m http.server 8080
# → http://localhost:8080/<name>.html
```

After creating / editing:
```bash
cd ~/projects/lyra-stack && make diagrams deploy
```
