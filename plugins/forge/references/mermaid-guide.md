# Mermaid Guide

## Critical Rules

1. **Never use bare `<pre class="mermaid">`** — always wrap in `.diagram-shell` with zoom/pan
2. **Never use `rgba()` in style directives** — hex colors only
3. **Never define `.node` as page-level CSS** — breaks Mermaid's internal classes
4. **Never use `theme: 'dark'`** — always use `theme: 'base'` with custom `themeVariables`

## Diagram-Shell Pattern (Required)

Always wrap Mermaid diagrams in the shell structure:

```html
<div class="diagram-shell">
  <div class="section-title">3.1 — Process Flow</div>  <!-- optional but recommended -->
  <div class="zoom-controls">
    <button data-zoom="in" title="Zoom in">+</button>
    <button data-zoom="fit" title="Fit">⤢</button>
    <button data-zoom="out" title="Zoom out">−</button>
  </div>
  <div class="mermaid-container" data-mermaid-out id="diagram-{ID}"></div>
  <script type="text/plain" data-mermaid>
flowchart TD
    A["Node A"] --> B["Node B"]
    style A fill:#374151,color:#9ca3af,stroke:#e85d04,stroke-width:2px
  </script>
</div>
```

This provides:
- Fixed-height container (500px) for pan/zoom
- Consistent zoom controls across all diagrams
- Section title for context
- Theme-aware styling via CSS variables

---

## Single-File Mermaid (no pitfalls)

For standalone HTML (not inside a fetched tab), use standard ESM initialization:

```html
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      primaryColor:       'var(--surface)',
      primaryTextColor:   'var(--text)',
      primaryBorderColor: 'var(--accent)',
      lineColor:          'var(--text-dim)',
      secondaryColor:     'var(--border)',
      background:         'var(--bg)',
      edgeLabelBackground:'var(--surface)',
      nodeTextColor:      'var(--text-muted)',
    },
    flowchart: { useMaxWidth: false, curve: 'basis' }
  })
</script>
<script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.2/dist/svg-pan-zoom.min.js"></script>
```

Render + pan/zoom init:

```javascript
(async function() {
  const container = document.getElementById('diagram-{ID}')
  const sourceEl = container?.previousElementSibling
  if (!container || !sourceEl) return
  const { svg } = await mermaid.render('mermaid-svg-{ID}', sourceEl.textContent)
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

---

## Dynamic Tabs — Three Pitfalls

When Mermaid lives inside a tab fragment loaded via `fetch()` + `innerHTML`, three things break.

### Pitfall 1 — rgba() in style declarations

Mermaid's `style` directive splits on commas. Commas inside `rgba(r,g,b,a)` are parsed as property separators → **syntax error**.

```
%% BROKEN — commas inside rgba conflict with style parser
style NODE fill:rgba(232,93,4,0.06),stroke:#c2410c

%% CORRECT — hex only
style NODE fill:#1a1008,stroke:#c2410c,stroke-width:1px,color:#9ca3af
```

**Rule: never use `rgba()` or `hsl()` in Mermaid `style` directives. Hex colors only.**

---

### Pitfall 2 — innerHTML decodes entities before Mermaid sees them

`mermaid.run()` called after `panel.innerHTML = html` causes HTML entities to decode early. `&nbsp;` becomes U+00A0, `<br/>` becomes raw text, etc.

**Solution: store diagram source in `<script type="text/plain">`, extract via `.textContent`, render via `mermaid.render()`.**

The diagram-shell pattern uses this approach:
- `<script type="text/plain" data-mermaid>` — holds the raw source
- `data-mermaid-out` container — receives the rendered SVG

In the **shell JS**, the `window.__postLoad` hook looks for `[data-mermaid]` and `[data-mermaid-out]` attributes — no IDs to collide across tabs.

---

### Pitfall 3 — No built-in zoom/pan

Use `svg-pan-zoom@3.6.2` (UMD build, not ESM). Disable built-in icons; use custom HTML overlay buttons.

The diagram shell includes zoom controls by default:
- `+` button → `pz.zoomIn()`
- `−` button → `pz.zoomOut()`
- `⤢` button → `pz.resetZoom(); pz.resetPan(); pz.fit(); pz.center()`

---

## Mermaid Syntax Checklist (dynamic tabs)

Before deploying Mermaid inside a split-file tab, verify:

- [ ] **Wrapped in diagram-shell** — never bare `<pre class="mermaid">`
- [ ] **Zoom controls present** — `+` / `⤢` / `−` buttons above container
- [ ] `style` directives: hex colors only — no `rgba()`, no `hsl()`
- [ ] Diagram source: in `<script type="text/plain" data-mermaid>`, extracted via `.textContent`
- [ ] Rendered via `mermaid.render()`, **not** `mermaid.run()`
- [ ] `theme: 'base'` with custom `themeVariables` — never `'dark'` or `'default'`
- [ ] `useMaxWidth: false` in flowchart config
- [ ] Zoomable diagrams: `svg-pan-zoom` loaded in shell `<head>`, SVG height/width `100%`, `maxWidth` removed
- [ ] Subgraph IDs prefixed `CHAIN_` (avoid clashes with node IDs)
- [ ] Max 10–12 nodes per diagram (split complex ones)
- [ ] No emoji in node labels
- [ ] No indigo/violet colors (`#8b5cf6`, etc.) — off-brand
- [ ] Labels with special chars quoted: `["label"]`
- [ ] `#` in labels inside `["..."]` works without escaping

---

## Mermaid Container CSS

The `.diagram-shell`, `.mermaid-container`, `.zoom-controls`, and `.section-title` styles are in `base/components.css` and `base/explainer-base.css`. Include those files in your base layer:

```
/* BASE_STYLES: Concatenate base/*.css in order: reset → layout → typography → components → explainer-base */
{BASE_STYLES}
```

For project-specific overrides, add to `css/<name>.css`:

```css
/* Override container height for smaller diagrams */
.mermaid-container.compact { height: 350px; }

/* Override container height for large diagrams */
.mermaid-container.tall { height: 650px; }
```

---

## Section Title for Diagrams

Always add a section title before the diagram shell:

```html
<div class="section-title">2.1 — Architecture Overview</div>
<div class="diagram-shell">
  ...
</div>
```
