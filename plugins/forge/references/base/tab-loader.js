/* ══════════════════════════════════════════════════════════════════
   tab-loader.js — lazy tab loading + activation for split-file diagrams
   Part of forge base/ layer.

   IMPORTANT: Before inlining, substitute {NAME} with the diagram's
   kebab-case slug (e.g., "lyra-user-guide"). The fetch URL uses it
   to locate tab fragment files at tabs/{NAME}/tab-{id}.html.

   Theme toggle is NOT here — it lives inline in shells/ per ADR-011.
   ══════════════════════════════════════════════════════════════════ */

;(function () {
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
