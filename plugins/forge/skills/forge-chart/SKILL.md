---
name: forge-chart
description: 'Create a quick self-contained single-file HTML visual — Mermaid flowchart, dependency tree, sequence diagram, or CSS layout. No server needed, works with file://. Triggers: "draw" | "diagram" | "visualize" | "sketch" | "map" | "show the flow" | "quick visual".'
version: 0.3.0
allowed-tools: Read, Write, Bash, Glob, Grep, ToolSearch
---

# Chart — Single-File Quick Visual

Create a self-contained HTML file. All CSS/JS inline — no fetch, no external files, works with `file://`.
Use for: Mermaid flowcharts, dependency trees, sequence diagrams, simple CSS layouts.

Output: `~/.roxabi/forge/<project>/visuals/{slug}.html` or `~/.roxabi/forge/_shared/diagrams/{slug}.html`.

**Read before generating:**

```
${CLAUDE_PLUGIN_ROOT}/references/forge-ops.md              — brand detection, output paths, deploy commands
${CLAUDE_PLUGIN_ROOT}/references/base/reset.css            — concatenate first
${CLAUDE_PLUGIN_ROOT}/references/base/layout.css           — concatenate second
${CLAUDE_PLUGIN_ROOT}/references/base/typography.css       — concatenate third
${CLAUDE_PLUGIN_ROOT}/references/base/components.css       — concatenate fourth
${CLAUDE_PLUGIN_ROOT}/references/base/explainer-base.css   — concatenate fifth (visual explainer components)
${CLAUDE_PLUGIN_ROOT}/references/aesthetics/               — select one based on detection logic
${CLAUDE_PLUGIN_ROOT}/references/shells/single.html        — HTML template with placeholders
${CLAUDE_PLUGIN_ROOT}/references/diagram-meta.md           — meta tag format + categories
${CLAUDE_PLUGIN_ROOT}/references/graph-templates/README.md — graph/topology templates (read when visual type = architecture/topology)
${CLAUDE_PLUGIN_ROOT}/references/mermaid-guide.md          — Mermaid patterns for dynamic tabs
```

**Directive: inline, never link** — `base/` and `aesthetics/` files are generation source, not runtime dependencies. Read → inline into output `<style>` block.

**Exception — graph-templates/fgraph-base.css has two distribution modes:**
- **Mode A (default — single-file HTML):** inline into output `<style>` block, same as `base/`. Required for anything that must work with `file://`.
- **Mode B (multi-tab docs):** copy to `~/.roxabi/forge/_shared/fgraph-base.css` once, then reference via `<link rel="stylesheet" href="../../_shared/fgraph-base.css">` in the shell `<head>`. Use when ≥ 2 tabs in the same doc use fgraph classes. Matches the `gallery-base.{css,js}` precedent.
- Decision rule: `forge-chart` single-file output → Mode A. Multi-tab roadmap / spec shell → Mode B. See `references/graph-templates/README.md` "Inlined vs shared" for the full rulebook.

---

## Aesthetic Detection

| Priority | Signal | Aesthetic |
|----------|--------|-----------|
| 1 | Explicit `--aesthetic` arg | As specified |
| 2 | Brand book found (`BRAND-BOOK.md`) | Derived from palette |
| 3 | Project = `lyra` / `voicecli` | `lyra.css` |
| 4 | Project = `roxabi*` / `2ndBrain` | `roxabi.css` |
| 5 | Content = architecture / spec | `blueprint.css` |
| 6 | Content = CLI / terminal doc | `terminal.css` |
| 7 | Default | `editorial.css` |

---

## Shell Processing

1. Read `shells/single.html` template
2. Concatenate base CSS files in order: `reset → layout → typography → components → explainer-base`
3. Read selected aesthetic CSS
4. Substitute placeholders:
   - `{NAME}` → diagram slug (for localStorage key scoping)
   - `{BASE_STYLES}` → concatenated base CSS
   - `{AESTHETIC_STYLES}` → aesthetic CSS (editorial.css if default)
   - `{TITLE}`, `{DATE}`, `{CATEGORY}`, `{CAT_LABEL}`, `{COLOR}`, `{BADGES}` → diagram metadata
   - `{HEAD_EXTRAS}` → mermaid CDN script + svg-pan-zoom CDN (for diagrams)
   - `{CONTENT}` → diagram body (hero section, Mermaid container, cards, etc.)
   - `{EXTRA_STYLES}` → diagram-specific CSS (if any)
   - `{EXTRA_SCRIPTS}` → theme toggle JS + Mermaid init + pan/zoom init + reveal observer
5. Output: single self-contained HTML file (file:// safe)

Mermaid note: single-file has **no dynamic-tab pitfalls** — use standard `startOnLoad: true`. No need for `mermaid.render()`, no `rgba()` restriction.

Let:
  ARGS := $ARGUMENTS

---

## Phase 1 — Context

1. Detect project from ARGS or cwd.
2. Issue number in ARGS (`#N` or `NNN-`) → filename `{N}-{slug}.html`, set `diagram:issue` meta.
3. Cross-project / no project → `~/.roxabi/forge/_shared/diagrams/`.
4. Brand book — follow `forge-ops.md` brand detection.
5. Apply aesthetic detection logic to select the correct aesthetic file.

---

## Phase 2 — Visual Type

| Content | Approach |
|---------|----------|
| Task / issue dependency graph | Mermaid `flowchart TD` or `LR` |
| Data flow between services (linear) | Mermaid `flowchart LR` |
| API / message sequence | Mermaid `sequenceDiagram` |
| State machine | Mermaid `stateDiagram-v2` |
| **Hub-and-spoke / message bus / gateway (≤ 6 peers, rich cards)** | **fgraph — `graph-templates/radial-hub.html` + `fgraph-base.css`** |
| Architecture layers (stacked, text-heavy) | CSS Grid cards (no Mermaid) |
| Simple timeline | CSS flex with connectors |

**Decision rule for architecture diagrams:**
- Linear flow / topology / > 8 nodes → Mermaid (dagre auto-layout wins)
- Radial / hub-and-spoke with rich cards (pills, warn, multi-line) → fgraph
- Stacked text-heavy pipelines → CSS Grid cards
- See `references/graph-templates/README.md` for the full decision matrix.

Max 12 nodes per Mermaid diagram (split if more). fgraph-radial caps at ~6 satellites before labels collide.

Choose `diagram:category` + `diagram:color` from `references/diagram-meta.md`.

---

## Phase 3 — Generate

Read `shells/single.html` → substitute placeholders with content. The shell already contains:
- Theme toggle JS
- Diagram meta placeholders
- CSS placeholder slots

### Hero Section (REQUIRED)

Every chart MUST have a hero section. Use the **left border variant** by default:

```html
<section class="hero left-border">
  <div class="hero-inner">
    <div class="hero-label">{{EYEBROW}}</div>
    <h1>{{TITLE_PLAIN}} <span class="accent">{{TITLE_ACCENT}}</span></h1>
    <p>{{SUBTITLE}}</p>
    <div class="tag-row">
      <span class="tag {{TAG_TONE}}">{{TAG_TEXT}}</span>
    </div>
  </div>
</section>
```

Hero variants:
- `left-border` (default) — clean, minimal
- `top-border` — elegant, centered
- `elevated` — audit style with card background

### Section Labels (REQUIRED)

Use section labels with **dot prefix** for each major section:

```html
<div class="section-label dot">1.1 — Section Name</div>
```

Variants: `dot` (default), `triangle`, `square`.

### Diagram Shell (REQUIRED for Mermaid)

**NEVER use bare `<pre class="mermaid">`.** Always wrap in the diagram shell:

```html
<div class="diagram-shell">
  <div class="zoom-controls">
    <button data-zoom="in" title="Zoom in">+</button>
    <button data-zoom="fit" title="Fit">⤢</button>
    <button data-zoom="out" title="Zoom out">−</button>
  </div>
  <div class="mermaid-container" data-mermaid-out id="diagram-{{ID}}"></div>
  <script type="text/plain" data-mermaid>
    {{MERMAID_SOURCE}}
  </script>
</div>
```

### Mermaid Initialization

Add to `{HEAD_EXTRAS}`:

```html
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      primaryColor: 'var(--surface)',
      primaryTextColor: 'var(--text)',
      primaryBorderColor: 'var(--accent)',
      lineColor: 'var(--text-dim)',
      secondaryColor: 'var(--border)',
      background: 'var(--bg)',
      edgeLabelBackground: 'var(--surface)',
      nodeTextColor: 'var(--text-muted)',
    },
    flowchart: { useMaxWidth: false, curve: 'basis' }
  })
</script>
<script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.2/dist/svg-pan-zoom.min.js"></script>
```

Add to `{EXTRA_SCRIPTS}` (after Mermaid render):

```javascript
// Mermaid render + pan/zoom init
(async function() {
  const container = document.getElementById('diagram-{{ID}}')
  const sourceEl = container?.previousElementSibling
  if (!container || !sourceEl) return
  const { svg } = await mermaid.render('mermaid-svg-{{ID}}', sourceEl.textContent)
  container.innerHTML = svg
  const svgEl = container.querySelector('svg')
  if (svgEl) {
    svgEl.setAttribute('height', '100%')
    svgEl.setAttribute('width', '100%')
    svgEl.style.maxWidth = 'none'
    if (window.svgPanZoom) {
      const pz = svgPanZoom(svgEl, {
        zoomEnabled: true, panEnabled: true,
        controlIconsEnabled: false,
        fit: true, center: true,
        minZoom: 0.15, maxZoom: 15
      })
      document.querySelector('[data-zoom="in"]')?.addEventListener('click', () => pz.zoomIn())
      document.querySelector('[data-zoom="out"]')?.addEventListener('click', () => pz.zoomOut())
      document.querySelector('[data-zoom="fit"]')?.addEventListener('click', () => { pz.resetZoom(); pz.resetPan(); pz.fit(); pz.center() })
    }
  }
})()
```

### Phase Cards (when applicable)

For process flows with distinct phases, use phase cards:

```html
<div class="phases">
  <div class="phase-card p1">
    <div class="phase-num">Phase 1</div>
    <div class="phase-title">{{TITLE}}</div>
    <ul>
      <li>{{ITEM_1}}</li>
      <li>{{ITEM_2}}</li>
    </ul>
  </div>
  <!-- repeat for p2, p3, p4 -->
</div>
```

### Reveal Animation (REQUIRED)

Add reveal observer to `{EXTRA_SCRIPTS}`:

```javascript
// Reveal on scroll
const obs = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible')
      obs.unobserve(e.target)
    }
  })
}, { threshold: 0.15 })
document.querySelectorAll('.reveal').forEach(el => obs.observe(el))
```

---

## Anti-Patterns (FORBIDDEN)

| Anti-Pattern | Fix |
|--------------|-----|
| Bare `<pre class="mermaid">` | Use diagram shell with `.mermaid-wrap` |
| ASCII art in `<pre class="arch">` | Convert to Mermaid flowchart or fgraph |
| Emoji in headers | Remove — use text only |
| `rgba()` in Mermaid `style` directives | Use hex colors only |
| `theme: 'dark'` in Mermaid config | Use `theme: 'base'` + custom `themeVariables` |
| Plain `<h2>` for section titles | Use `.section-title` class |
| No hero section | Add hero with left-border variant |

---

## Phase 4 — Report

```
Created: {path}/{slug}.html

Open:    file://{path}/{slug}.html     (no server needed)

Serve + Deploy: see forge-ops.md
```

$ARGUMENTS
