/* ══════════════════════════════════════════════════════════════════
   mermaid-init.js — Mermaid diagram rendering + pan/zoom
   Part of forge base/ layer. Inline verbatim (no placeholders).

   Only include when tabs contain Mermaid diagrams. Tab fragments
   must have: <script type="text/plain" data-mermaid>...</script>
   + <div data-mermaid-out></div> inside .mermaid-wrap or .mermaid-inner

   For pan/zoom, add to <head>:
     <script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.2/dist/svg-pan-zoom.min.js"></script>

   HTML pattern:
     <div class="mermaid-wrap">
       <div class="zoom-controls">
         <button data-zoom="in" title="Zoom in">+</button>
         <button data-zoom="fit" title="Fit">⤢</button>
         <button data-zoom="out" title="Zoom out">−</button>
       </div>
       <div class="mermaid-inner" data-mermaid-out></div>
       <script type="text/plain" data-mermaid>
         flowchart TD ...
       </script>
     </div>
   ══════════════════════════════════════════════════════════════════ */

window.__postLoad = async (id, panel) => {
  var srcEl = panel.querySelector('[data-mermaid]')
  var container = panel.querySelector('[data-mermaid-out]')
  if (!srcEl || !container) return

  var { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
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
    flowchart: { useMaxWidth: false, curve: 'basis' },
  })

  var { svg, bindFunctions } = await mermaid.render(`mermaid-${id}`, srcEl.textContent.trim())
  container.innerHTML = svg
  if (bindFunctions) bindFunctions(container.querySelector('svg'))

  // Set SVG to fill container for pan/zoom
  var svgEl = container.querySelector('svg')
  if (svgEl) {
    svgEl.setAttribute('height', '100%')
    svgEl.setAttribute('width', '100%')
    svgEl.style.maxWidth = 'none'
  }

  if (typeof window.__initPanZoom === 'function') window.__initPanZoom(container)
}

/* ── Pan/zoom initialization with custom button wiring ──
   Container should be inside .mermaid-wrap with .zoom-controls sibling.
   ══════════════════════════════════════════════════════════════════ */
window.__initPanZoom = (container) => {
  var svgEl = container.querySelector('svg')
  if (!svgEl || typeof svgPanZoom === 'undefined') return

  var pz = svgPanZoom(svgEl, {
    zoomEnabled: true,
    panEnabled: true,
    controlIconsEnabled: false,  // use custom HTML buttons
    fit: true,
    center: true,
    minZoom: 0.15,
    maxZoom: 15,
    zoomScaleSensitivity: 0.25,
  })

  // Wire custom zoom buttons (search up to mermaid-wrap, then down)
  var wrap = container.closest('.mermaid-wrap') || container.parentElement
  var zIn  = wrap.querySelector('[data-zoom="in"]')
  var zOut = wrap.querySelector('[data-zoom="out"]')
  var zFit = wrap.querySelector('[data-zoom="fit"]')

  if (zIn)  zIn.addEventListener('click', function () { pz.zoomIn() })
  if (zOut) zOut.addEventListener('click', function () { pz.zoomOut() })
  if (zFit) zFit.addEventListener('click', function () {
    pz.resetZoom()
    pz.resetPan()
    pz.fit()
    pz.center()
  })
}
