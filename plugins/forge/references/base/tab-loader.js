/* ══════════════════════════════════════════════════════════════════
   tab-loader.js — lazy tab loading + activation for split-file diagrams
   Part of forge base/ layer.

   IMPORTANT: Before inlining, substitute {NAME} with the diagram's
   kebab-case slug (e.g., "lyra-user-guide"). The fetch URL uses it
   to locate tab fragment files at tabs/{NAME}/tab-{id}.html.

   Theme toggle is NOT here — it lives inline in shells/ per ADR-011.
   ══════════════════════════════════════════════════════════════════ */

;(() => {
  function loadPanel(id) {
    var panel = document.querySelector(`[data-panel="${id}"]`)
    if (!panel || panel._loaded) return
    fetch(`tabs/{NAME}/tab-${id}.html`)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((html) => {
        panel.innerHTML = html
        panel._loaded = true
        if (typeof window.__postLoad === 'function') window.__postLoad(id, panel)
      })
      .catch((e) => {
        var err = document.createElement('p')
        err.style.cssText = 'padding:2rem;color:var(--text-muted)'
        err.textContent = `Failed to load (${e})`
        panel.innerHTML = ''
        panel.appendChild(err)
      })
  }

  function activate(id) {
    document.querySelectorAll('[data-tab]').forEach((t) => {
      var isSelected = t.dataset.tab === id
      t.classList.toggle('active', isSelected)
      t.setAttribute('aria-selected', isSelected ? 'true' : 'false')
      t.setAttribute('tabindex', isSelected ? '0' : '-1')
    })
    document.querySelectorAll('[data-panel]').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === id)
    })
    loadPanel(id)
  }

  document.querySelectorAll('[data-tab]').forEach((t) => {
    t.addEventListener('click', () => {
      activate(t.dataset.tab)
    })
  })

  var first = document.querySelector('[data-tab]')
  if (first) activate(first.dataset.tab)
})()
