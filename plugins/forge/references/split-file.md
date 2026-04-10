# Split-File Pattern

Multi-tab explainers use four file groups relative to the diagram root:

```
<name>.html              — shell: head, nav, empty panel placeholders
css/<name>.css           — all styles (base + aesthetic + diagram-specific)
js/<name>.js             — tab-loader + theme toggle + optional Mermaid init
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

## Shell Template

Read `shells/split.html` for the complete template. It contains all necessary placeholders:

| Placeholder | Content |
|-------------|---------|
| `{TITLE}`, `{DATE}`, `{CATEGORY}`, `{CAT_LABEL}`, `{COLOR}`, `{BADGES}` | Diagram metadata |
| `{BASE_STYLES}` | Concatenated base CSS (reset → layout → typography → components) |
| `{AESTHETIC_STYLES}` | Selected aesthetic CSS |
| `{TABS}` | Tab button elements |
| `{PANELS}` | Panel container elements |
| `{TAB_LOADER_JS}` | tab-loader.js with `{NAME}` substituted |
| `{HEAD_EXTRAS}` | Optional (e.g., svg-pan-zoom CDN) |
| `{EXTRA_STYLES}` | Diagram-specific CSS |
| `{EXTRA_SCRIPTS}` | Optional (e.g., mermaid-init.js) |

**Directive: inline, never link** — skills should read and inline all CSS/JS, not link to external files.

---

## Tab Fragments

Content patterns by tab type:

| Tab type | Content |
|----------|---------|
| Overview / intro | `<h1>`, 1–2 `<p>`, `.cards` grid (2–4 cards) |
| Step-by-step | `<h2>` sections + `<ol>` + `<pre><code>` |
| Architecture | Mermaid diagram + description |
| Comparison | `.table-wrap > table` with `<thead>` |
| Status / KPIs | `.cards` grid with stat cards |
| Decisions / log | `<h3>` entries with date + rationale `<p>` |

---

## Mermaid Support

If any tab will contain a Mermaid diagram, see `references/mermaid-guide.md` for the complete checklist (dynamic tab pitfalls, `__postLoad`, `__initPanZoom`).

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
cd ~/projects/lyra-stack && make forge deploy
```
