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

## Design Phase — Frame → Structure → Style → Deliver

Decisions made across Phases 1–4 follow this lens. It is an overlay on the procedural phases, not a separate pre-phase: Frame runs in Phase 1 (context + aesthetic detection), Structure in Phase 2 (visual type), Style in Phase 3 (generate), Deliver in Phase 4 (report + verify).

### Track selection (Phase 1 start)

Run the brand book loader (`${CLAUDE_PLUGIN_ROOT}/references/brand-book-loader.md`) before any other decision:

- **Track A (branded)** — `forge.yml` found in project `brand/` → aesthetic/palette/typography locked; components pre-filled; `deliver_must_match` rules enforced at Deliver.
- **Track B (exploration)** — no brand book → full Frame judgment; Frame output drives aesthetic fallback via `forge-ops.md § Aesthetic Detection` priority 5.

Full track-by-track behavior: `${CLAUDE_PLUGIN_ROOT}/references/design-phase-two-track.md`.

Report the loaded brand book (or its absence) before starting Frame. Track is fixed at Phase 1 and does not change.

### Frame — What's this visual for?

Full reference: `${CLAUDE_PLUGIN_ROOT}/references/frame-phase.md` — three Frame questions, reader-action matrix, tone dimensions, example trace.

**For forge-chart specifically, Q4 (sentence verb) is the most useful prompt.** A chart is usually a single visual with one dominant reader action — *see*, *debug*, *decide*, *learn*, *trust*. Commit to the verb before picking topology: a *see* verb tolerates spacious fgraph; a *debug* verb demands dense stat-grid + high contrast.

- **Track A:** ask Q1 (reader-action) and Q2 (takeaway). **Skip Q3 (tone)** — tone is pre-constrained by brand voice rules in `deliver_must_match`. Q4 optional.
- **Track B:** ask Q1, Q2, and full Q3 (all four tone axes). Frame output produces a content-type signal for Aesthetic Detection priority 5.

Aesthetic is never chosen by Frame — it's mechanical (see `forge-ops.md § Aesthetic Detection`). Frame produces purpose, not CSS.

### Structure — Which visual type?

Content-driven in both tracks. Brand `structure_defaults` (if present) act as **tiebreakers only** when content topology is genuinely ambiguous.

| Content | Approach | Why |
|---|---|---|
| Task / dependency graph | Mermaid `flowchart TD` | Dagre auto-layout for trees |
| Data flow (linear) | Mermaid `flowchart LR` | Left-to-right reads naturally |
| API sequence | Mermaid `sequenceDiagram` | Time-ordered interactions |
| State machine | Mermaid `stateDiagram-v2` | Native cycle support |
| **Hub-and-spoke, ≤ 6 peers, rich cards** | **fgraph radial** | Pills, warn lines, multi-line |
| 7 radial nodes | fgraph with narrow nodes, or split into sub-diagrams | fgraph caps at ~6 before labels collide |
| Architecture layers | CSS Grid cards | Stacked, text-heavy |
| **Comparison / matrix (≥4 rows or ≥3 cols)** | **HTML `<table>`** | Tabular data is not a graph |
| Simple timeline | `.steps` timeline component | Shared CSS, no auto-layout needed |

**Decision rule:** > 8 nodes or linear → Mermaid. ≤ 6 radial with rich cards → fgraph. Tabular → HTML table. Stacked text → Grid.

**Node shapes (fgraph):** When using fgraph, pick the right shape modifier for each node. Read [`${CLAUDE_PLUGIN_ROOT}/references/shape-vocabulary.md`](${CLAUDE_PLUGIN_ROOT}/references/shape-vocabulary.md) for the full semantic mapping. Quick reference: `.cylinder` = database, `.hexagon` = agent/worker, `.diamond` = decision/gate, `.circle` = event/trigger, `.folded` = file/config, `.pill` = bus/broker, default rect = service/process.

**Arrow modifiers (fgraph):** `.dashed` = optional/async, `.thick` = critical path, `.animated` = live stream. Compose with tones: `<path class="fg-edge amber thick">`.

**Ask:** How many nodes? Any cycles? If you sketch the content twice — once radial, once linear — which reads faster on a 1200px screen? Content that takes two sketches to understand is a signal to split the diagram, not to cram both into one.

### Style — Which components?

All classes below exist in `base/components.css` + `base/explainer-base.css`.

- **Track A:** component slots (hero, section-label, card, timeline, badges) are **pre-filled** from `brand.components.*`. Override a slot only when the content's Structure output has no valid rendering using the brand default (see `design-phase-two-track.md § Style` partial override rule). Stylistic preference is not a valid reason.
- **Track B:** pick the row that matches your Structure output. Frame tone drives variant selection when multiple rows could apply.

| Visual type | Hero | Sections | Extra |
|---|---|---|---|
| Flowchart (`flowchart TD/LR`) | `.hero.left-border` | `.section-label.dot` + diagram shell | `.phases` + `.phase-card` |
| Sequence (`sequenceDiagram`) | `.hero.left-border` | `.section-label.dot` + diagram shell | `.phases` (time-grouped arcs) + `.card.accent` legend |
| State machine (`stateDiagram-v2`) | `.hero.left-border` | `.section-label.dot` + diagram shell | `.card.accent` legend for state meanings |
| Radial hub (fgraph, ≤ 7 nodes) | `.hero.left-border` | `.section-label.dot` | `.card.accent` legend for edge types (pills/warn/ok) |
| Architecture layers | `.hero.elevated` | `.section-label.square` | `.stat-grid` + `.stat` |
| Timeline | `.hero.top-border` | `.section-label.triangle` | `.steps` + `.step` + `.step-num` |
| Explainer | `.hero.left-border` | `.section-label.dot` | `.io-strip` + `.io-box` + `.io-arrow` |
| Comparison | `.hero.left-border` | `.section-label.dot` | `.table-wrap > table` |

**Rendering wrappers** — orthogonal to visual type. Apply these to whatever rendering the Structure phase chose:

| Rendering | Wrapper / component |
|---|---|
| Mermaid (flowchart / sequence / state / class) | `.diagram-shell` with `.zoom-controls` (never bare `<pre class="mermaid">`) |
| fgraph radial | `.fgraph-wrap` + `.fgraph-frame` + `.fgraph-edges` + `.fgraph-node.{shape}.{tone}` (shapes: `.cylinder`/`.hexagon`/`.diamond`/`.circle`/`.folded`/`.pill` — see `shape-vocabulary.md`) |
| HTML table | `.table-wrap > table` with `<thead>` (enables sticky header + horizontal scroll) |
| CSS Grid cards | `.cards` container + `.card`/`.card.accent` per row |
| Timeline | `.steps` container + `.step > .step-num` per entry |
| Explainer I/O flow | `.io-strip` + `.io-box` + `.io-arrow` |

Cross-type: use `.card.info` / `.card.warning` / `.card.critical` for inline tonal callouts.

**Ask:** What's the ONE thing the reader should walk away remembering? A number → `.stat-grid`. A path through steps → `.steps` timeline. A comparison → `.table-wrap > table`. A decision with trade-offs → `.io-strip`. If more than one answer fits, the diagram is doing too much — Frame Q2 is underspecified.

### Deliver — Generate + verify

**Always** (both tracks):
- Mermaid (if used) wrapped in `.diagram-shell` with zoom controls — never bare `<pre class="mermaid">`.
- SVG gets `height: 100%; width: 100%; max-width: none` after `mermaid.render()`.
- No ASCII art, no emoji in section headers.
- Interactive controls (zoom, theme) are `<button>` with visible `:focus-visible` styling.
- **Body copy uses `var(--text)` for maximum readability on dark backgrounds.** `var(--text-muted)` is for intermediate emphasis only (subtitles, label rows); `var(--text-dim)` is for metadata only. Never `var(--text-dim)` on `var(--surface)` for any body copy.
- Color pairs meet 4.5:1 contrast minimum (body text AAA when possible).
- Verify Frame Q2 takeaway is visually emphasized — the reader should spot it without reading the whole diagram.

**Track A additionally:**
- Run every `brand.deliver_must_match` rule against the generated output. Report pass/fail per rule with location. Do not write the file until all rules pass or the user explicitly overrides a failing rule.
- If `brand.examples` list is non-empty, offer to visually diff the generated output against one example before writing.

**If the chart is a rich explainer** (multi-section, long-form):
- Hero section present (`.hero.left-border` / `.elevated` / `.top-border`) with eyebrow + title accent.
- Section labels present (`.section-label.dot` / `.triangle` / `.square`).
- Reveal observer wired for `.reveal` elements.

**If the chart is a single quick diagram** (one Mermaid / fgraph block, no narrative):
- Hero and section labels are **optional** — a minimal title + diagram is acceptable.
- Reveal observer is **not needed** (no `.reveal` elements to observe).

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
4. **Run the brand book loader** (`${CLAUDE_PLUGIN_ROOT}/references/brand-book-loader.md`): Discovery → Parse → Apply. Determine Track A or Track B. Report the result before continuing.
5. Apply the Aesthetic Detection precedence algorithm (see `${CLAUDE_PLUGIN_ROOT}/references/forge-ops.md` § Aesthetic Detection) to select the correct aesthetic file. If Track A, `forge.yml` already locks it at priority 2.

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

### Hero Section

Every chart SHOULD have a hero section. Use the **left border variant** by default. Exception: single quick diagrams (one Mermaid / fgraph block, no narrative) — a minimal title + diagram is acceptable without a hero.

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

### Reveal Animation

Add reveal observer to `{EXTRA_SCRIPTS}` (skip for single quick diagrams with no `.reveal` elements):

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
| Bare `<pre class="mermaid">` | Use `.diagram-shell` with zoom controls |
| ASCII art in `<pre class="arch">` | Convert to Mermaid flowchart or fgraph |
| Emoji in headers | Remove — use text only |
| `rgba()` in Mermaid `style` directives | Use hex colors only |
| `theme: 'dark'` in Mermaid config | Use `theme: 'base'` + custom `themeVariables` |
| Plain `<h2>` for section titles | Use `.section-title` class |
| No hero section (multi-section chart) | Add hero with left-border variant |

---

## Phase 4 — Report

```
Created: {path}/{slug}.html

Open:    file://{path}/{slug}.html     (no server needed)

Serve + Deploy: see forge-ops.md
```

$ARGUMENTS
