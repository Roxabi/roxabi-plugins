# Mermaid Guide

## Single-File Mermaid (no pitfalls)

For standalone HTML (not inside a fetched tab), use standard ESM initialization:

```html
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
  mermaid.initialize({
    startOnLoad: true,
    theme: 'base',
    themeVariables: {
      primaryColor:       '#18181f',
      primaryTextColor:   '#fafafa',
      primaryBorderColor: '#e85d04',   /* replace with brand accent */
      lineColor:          '#6b7280',
      secondaryColor:     '#2a2a35',
      background:         '#0a0a0f',
      edgeLabelBackground:'#18181f',
      nodeTextColor:      '#9ca3af',
    },
    flowchart: { useMaxWidth: false, curve: 'basis' }
  })
</script>

<!-- Diagram -->
<div class="mermaid">
flowchart TD
    A["Node A"] --> B["Node B"]
</div>
```

No fetch involved → no pitfalls. Works with `file://`.

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

In the **tab fragment** (`tabs/<name>/tab-<id>.html`):

```html
<div data-mermaid-out id="diagram-output-{id}"></div>
<script type="text/plain" data-mermaid>
flowchart TD
    A["#447 &nbsp;Bus impl<br/><b>S</b>"]
    B["#448 &nbsp;NATS install<br/><b>S</b>"]
    A --> B
    style A fill:#374151,color:#9ca3af,stroke:#e85d04,stroke-width:2px
</script>
```

In the **shell JS**, the `window.__postLoad` hook (see `split-file.md` JS skeleton) looks for `[data-mermaid]` and `[data-mermaid-out]` attributes — no IDs to collide across tabs.

---

### Pitfall 3 — No built-in zoom/pan

Use `svg-pan-zoom@3.6.2` (UMD build, not ESM). Disable built-in icons; use custom HTML overlay buttons.

Add to shell `<head>`:
```html
<script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.2/dist/svg-pan-zoom.min.js"></script>
```

`window.__initPanZoom` implementation (add to shell JS after `window.__postLoad`):

```javascript
window.__initPanZoom = function (container) {
  var svgEl = container.querySelector('svg')
  if (!svgEl) return
  svgEl.setAttribute('height', '100%')
  svgEl.setAttribute('width',  '100%')
  svgEl.style.maxWidth = 'none'
  var pz = svgPanZoom(svgEl, {
    zoomEnabled: true, panEnabled: true,
    controlIconsEnabled: false,
    fit: true, center: true,
    minZoom: 0.15, maxZoom: 15,
    zoomScaleSensitivity: 0.25,
  })
  // Wire custom buttons placed near the diagram container:
  var zIn  = container.parentElement.querySelector('[data-zoom="in"]')
  var zOut = container.parentElement.querySelector('[data-zoom="out"]')
  var zFit = container.parentElement.querySelector('[data-zoom="fit"]')
  if (zIn)  zIn.addEventListener ('click', function () { pz.zoomIn() })
  if (zOut) zOut.addEventListener('click', function () { pz.zoomOut() })
  if (zFit) zFit.addEventListener('click', function () { pz.resetZoom(); pz.resetPan(); pz.fit(); pz.center() })
}
```

Custom button HTML (inside the tab fragment, above the diagram):
```html
<div class="zoom-controls">
  <button data-zoom="in"  title="Zoom in">+</button>
  <button data-zoom="fit" title="Fit">⤢</button>
  <button data-zoom="out" title="Zoom out">−</button>
</div>
<div class="mermaid-container" data-mermaid-out></div>
<script type="text/plain" data-mermaid>
  <!-- diagram source here -->
</script>
```

---

## Mermaid Syntax Checklist (dynamic tabs)

Before deploying Mermaid inside a split-file tab, verify:

- [ ] `style` directives: hex colors only — no `rgba()`, no `hsl()`
- [ ] Diagram source: in `<script type="text/plain" data-mermaid>`, extracted via `.textContent`
- [ ] Rendered via `mermaid.render()`, **not** `mermaid.run()`
- [ ] `useMaxWidth: false` in flowchart config
- [ ] Zoomable diagrams: `svg-pan-zoom` loaded in shell `<head>`, SVG height/width `100%`, `maxWidth` removed
- [ ] Subgraph IDs prefixed `CHAIN_` (avoid clashes with node IDs)
- [ ] Max 10–12 nodes per diagram (split complex ones)
- [ ] No indigo/violet colors (`#8b5cf6`, etc.) — off-brand
- [ ] Labels with special chars quoted: `["label"]`
- [ ] `#` in labels inside `["..."]` works without escaping

---

## Mermaid Container CSS (split-file)

Add to `css/<name>.css`:

```css
.mermaid-container {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  overflow: auto;
  min-height: 300px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.5rem;
  margin-bottom: 1rem;
}
.mermaid-container svg { max-width: none; }
.zoom-controls {
  display: flex; gap: 0.5rem; margin-bottom: 0.5rem;
}
.zoom-controls button {
  padding: 0.25rem 0.625rem; font-size: 1rem; font-family: inherit;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 4px; color: var(--text-dim); cursor: pointer;
}
.zoom-controls button:hover { color: var(--text-muted); }
```
