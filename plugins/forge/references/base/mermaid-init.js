/* ══════════════════════════════════════════════════════════════════
   mermaid-init.js — Mermaid diagram rendering + optional pan/zoom
   Part of forge base/ layer. Inline verbatim (no placeholders).

   Only include when tabs contain Mermaid diagrams. Tab fragments
   must have: <pre data-mermaid>...</pre> + <div data-mermaid-out></div>

   For pan/zoom, add to <head>:
     <script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.2/dist/svg-pan-zoom.min.js"></script>
   ══════════════════════════════════════════════════════════════════ */

window.__postLoad = async (id, panel) => {
  var srcEl = panel.querySelector('[data-mermaid]')
  var container = panel.querySelector('[data-mermaid-out]')
  if (!srcEl || !container) return
  var { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    flowchart: { useMaxWidth: false, curve: 'basis' },
  })
  var { svg, bindFunctions } = await mermaid.render(`mermaid-${id}`, srcEl.textContent.trim())
  container.innerHTML = svg
  if (bindFunctions) bindFunctions(container.querySelector('svg'))
  if (typeof window.__initPanZoom === 'function') window.__initPanZoom(container)
}

window.__initPanZoom = (container) => {
  var svgEl = container.querySelector('svg')
  if (!svgEl || typeof svgPanZoom === 'undefined') return
  svgEl.style.maxWidth = 'none'
  svgEl.style.height = 'auto'
  svgPanZoom(svgEl, {
    zoomEnabled: true,
    controlIconsEnabled: true,
    fit: true,
    center: true,
    minZoom: 0.5,
    maxZoom: 4,
  })
}
