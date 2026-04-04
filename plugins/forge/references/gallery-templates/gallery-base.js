/* ══════════════════════════════════════════════════════════════════
   gallery-base.js — shared utilities for forge gallery templates
   v0.1.0

   Provides: theme toggle, dynamic filter builder, filter application,
   segmented control wiring, file discovery.

   Each template adds its own <script> block for rendering, lightbox,
   starring, boot logic, etc.
   ══════════════════════════════════════════════════════════════════ */

/* ── Theme ── */

/**
 * Initialize dark/light theme toggle with localStorage persistence.
 * Requires: element #themeBtn, html[data-theme].
 * @param {string} storeKey - localStorage prefix (e.g. 'lyra-avatar')
 * @returns {{ theme: string }} - mutable state object
 */
function initTheme(storeKey) {
  const stored = localStorage.getItem(`${storeKey}-theme`) || 'dark'
  const state = { theme: stored }

  function apply(t) {
    document.documentElement.setAttribute('data-theme', t)
    document.getElementById('themeBtn').textContent = t === 'dark' ? '\u{1F319}' : '\u2600\uFE0F'
    localStorage.setItem(`${storeKey}-theme`, t)
    state.theme = t
  }

  document.getElementById('themeBtn').addEventListener('click', () => {
    apply(state.theme === 'dark' ? 'light' : 'dark')
  })

  apply(stored)
  return state
}

/* ── Dynamic filter builder ── */

/**
 * Build check-btn filter buttons from data + dimension definitions.
 * Rule: all buttons OFF = inactive = show everything.
 *
 * @remarks
 * **Dual-API contract:** this function is type-agnostic about the items it receives.
 * `dim.fn` is called with each element of `items` verbatim — whether that's a filename
 * string (as in pivot-gallery.html) or a structured item object (as in comparison-gallery,
 * audio-gallery, and multi-mode-gallery). The caller picks the representation and
 * defines `dim.fn` accordingly. No runtime type inspection happens inside this function.
 *
 * Filename-string example:
 *     buildDimFilters(files, { batch: { label:'Batch', fn: f => f[0] } }, ...)
 *
 * Item-object example:
 *     buildDimFilters(items, { rarity: { label:'Rarity', fn: it => it.rarity } }, ...)
 *
 * See README §"Items-as-objects vs filename-strings" for when to pick each.
 *
 * @param {Array} items - Data array to scan. Elements can be strings, objects, or anything `dim.fn` accepts.
 * @param {Object} dims - { key: { label: string, fn: item => string, order?: string[] } }
 * @param {Object} filters - Mutable map: dim key → Set (empty = inactive). Populated by this function.
 * @param {string} barId - ID of the toolbar element to insert buttons into
 * @param {Function} renderFn - Called after any filter toggle
 */
function buildDimFilters(items, dims, filters, barId, renderFn) {
  const bar = document.getElementById(barId)

  for (const [key, dim] of Object.entries(dims)) {
    const counts = {}
    items.forEach((item) => {
      const v = dim.fn(item)
      counts[v] = (counts[v] || 0) + 1
    })
    const values = Object.keys(counts).sort((a, b) => {
      if (dim.order) {
        const ia = dim.order.indexOf(a),
          ib = dim.order.indexOf(b)
        if (ia >= 0 && ib >= 0) return ia - ib
        if (ia >= 0) return -1
        if (ib >= 0) return 1
      }
      return a.localeCompare(b)
    })

    if (values.length < 2) continue

    filters[key] = new Set()

    const ctrl = document.createElement('div')
    ctrl.className = 'ctrl'
    ctrl.innerHTML = `<span class="ctrl-label">${dim.label}</span>`
    const group = document.createElement('div')
    group.className = 'check-group'

    for (const v of values) {
      const btn = document.createElement('button')
      btn.className = 'check-btn'
      btn.dataset.b = v
      btn.textContent = `${v} (${counts[v]})`
      btn.onclick = () => {
        btn.classList.toggle('on')
        if (btn.classList.contains('on')) filters[key].add(v)
        else filters[key].delete(v)
        renderFn()
      }
      group.appendChild(btn)
    }
    ctrl.appendChild(group)
    bar.insertBefore(ctrl, bar.firstChild)
  }
}

/* ── Filter application ── */

/**
 * Apply active dimension filters to an array of items.
 *
 * @remarks
 * **Dual-API contract:** like {@link buildDimFilters}, this function is type-agnostic.
 * `dim.fn` receives whatever `items` contains — strings, objects, anything — and the
 * caller is responsible for defining `dim.fn` to match. No type inspection happens here.
 *
 * See {@link buildDimFilters} JSDoc for worked examples and the README subsection
 * "Items-as-objects vs filename-strings" for guidance on picking a representation.
 *
 * @param {Array} items - Items to filter (strings, objects, or anything `dim.fn` accepts)
 * @param {Object} dims - Dimension definitions with fn(item) → category
 * @param {Object} filters - Active filters: dim key → Set of selected values
 * @returns {Array} Filtered items (new array)
 */
function applyDimFilters(items, dims, filters) {
  let result = items
  for (const [dim, activeSet] of Object.entries(filters)) {
    if (activeSet.size === 0) continue
    const fn = dims[dim]?.fn
    if (fn) result = result.filter((item) => activeSet.has(fn(item)))
  }
  return result
}

/* ── Segmented controls ── */

/**
 * Wire a segmented control: click → toggle .on class, call handler.
 *
 * @param {string} containerId - ID of the .segs container
 * @param {Function} handler - Called with (value, button) on click
 */
function wireSegs(containerId, handler) {
  document.querySelectorAll(`#${containerId} .seg`).forEach((btn) => {
    btn.onclick = () => {
      // biome-ignore lint/suspicious/useIterableCallbackReturn: DOM forEach, no return needed
      document.querySelectorAll(`#${containerId} .seg`).forEach((b) => b.classList.remove('on'))
      btn.classList.add('on')
      handler(btn.dataset.v, btn)
    }
  })
}

/* ── File discovery ── */

/**
 * Discover files via manifest.json → /api/list/ fallback.
 * Returns array of filename strings.
 *
 * @param {string} dir - Directory path (relative to HTML)
 * @param {string} ext - File extension filter (e.g. '.png')
 * @returns {Promise<string[]>} Sorted filenames
 */
async function discoverFiles(dir, ext) {
  try {
    const r = await fetch(`${dir}manifest.json`)
    if (r.ok) {
      const listing = await r.json()
      return listing
        .filter((f) => f.name.endsWith(ext))
        .map((f) => f.name)
        .sort()
    }
  } catch (_) {}
  if (/^[\w./-]+$/.test(dir)) {
    try {
      const r = await fetch(`/api/list/${dir}`)
      if (r.ok) {
        const listing = await r.json()
        return listing
          .filter((f) => f.name.endsWith(ext))
          .map((f) => f.name)
          .sort()
      }
    } catch (_) {}
  }
  return []
}

/**
 * Discover batch of items with catalogue metadata.
 * Used by simple-gallery for multi-batch image galleries.
 *
 * @param {Object} cfg - { id, dir, ext?, catalogue? }
 * @param {Function} [itemBuilder] - Optional (stem, cfg) → item. Defaults to itemFromStem.
 * @returns {Promise<Array>} Array of item objects
 */
async function discoverBatch(cfg, itemBuilder) {
  const ext = cfg.ext || '.png'
  const build =
    itemBuilder ||
    ((stem, c) => {
      const meta = c.catalogue?.[stem] || { label: stem.replace(/-/g, ' '), tags: [] }
      return { stem, file: stem + ext, label: meta.label, tags: meta.tags || [], batch: c.id, dir: c.dir }
    })

  /* Try manifest.json */
  try {
    const r = await fetch(`${cfg.dir}manifest.json`)
    if (r.ok) {
      const listing = await r.json()
      return listing
        .filter((f) => f.name.endsWith(ext))
        .map((f) => f.name.replace(ext, ''))
        .sort()
        .map((stem) => build(stem, cfg))
    }
  } catch (_) {}
  /* Fallback: /api/list/ */
  if (/^[\w./-]+$/.test(cfg.dir)) {
    try {
      const r = await fetch(`/api/list/${cfg.dir}`)
      if (r.ok) {
        const listing = await r.json()
        return listing
          .filter((f) => f.name.endsWith(ext))
          .map((f) => f.name.replace(ext, ''))
          .sort()
          .map((stem) => build(stem, cfg))
      }
    } catch (_) {}
  }
  /* Fallback: catalogue keys */
  if (cfg.catalogue && Object.keys(cfg.catalogue).length) {
    return Object.keys(cfg.catalogue).map((stem) => build(stem, cfg))
  }
  return []
}

/* ── Batch bar ── */

/**
 * Build batch tab buttons from item counts.
 *
 * @param {Object} opts
 * @param {string} opts.barId - ID of the batch bar element
 * @param {Array} opts.batches - BATCHES config array
 * @param {Object} opts.counts - { batchId: count }
 * @param {number} opts.total - Total item count
 * @param {Function} opts.onSelect - Called with (batchId) on click
 */
function buildBatchBar(opts) {
  const bar = document.getElementById(opts.barId)
  bar.innerHTML = ''

  const allBtn = document.createElement('button')
  allBtn.className = 'batch-btn active'
  allBtn.dataset.batch = 'all'
  allBtn.textContent = `ALL (${opts.total})`
  allBtn.onclick = () => selectBatch(bar, allBtn, 'all', opts.onSelect)
  bar.appendChild(allBtn)

  for (const b of opts.batches) {
    if (!(opts.counts[b.id] > 0)) continue
    const btn = document.createElement('button')
    btn.className = 'batch-btn'
    btn.dataset.batch = b.id
    btn.textContent = `${b.id.toUpperCase()} \u2014 ${b.label} (${opts.counts[b.id] || 0})`
    btn.onclick = () => selectBatch(bar, btn, b.id, opts.onSelect)
    bar.appendChild(btn)
  }
}

function selectBatch(bar, btn, id, callback) {
  // biome-ignore lint/suspicious/useIterableCallbackReturn: DOM forEach, no return needed
  bar.querySelectorAll('.batch-btn').forEach((b) => b.classList.remove('active'))
  btn.classList.add('active')
  callback(id)
}

/* ── Starring ── */

/**
 * Create a starring manager with localStorage persistence.
 *
 * @param {string} storeKey - localStorage prefix
 * @param {string} [suffix='-starred'] - localStorage key suffix
 * @returns {{ has, toggle, size, set: Set }}
 */
function initStarred(storeKey, suffix) {
  const key = storeKey + (suffix || '-starred')
  const set = new Set(JSON.parse(localStorage.getItem(key) || '[]'))

  function save() {
    localStorage.setItem(key, JSON.stringify([...set]))
  }

  return {
    set,
    has: (id) => set.has(id),
    toggle: (id) => {
      if (set.has(id)) set.delete(id)
      else set.add(id)
      save()
      return set.has(id)
    },
    get size() {
      return set.size
    },
  }
}

/* ── HTML escaping ── */

/**
 * Escape a string for safe insertion into innerHTML / attribute contexts.
 * Covers &, <, >, ", ' to prevent XSS via user-controlled data
 * (filenames, manifest fields, tags, labels).
 *
 * @param {string} s - Raw string
 * @returns {string} HTML-safe string
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Validate a string as a safe CSS class name suffix.
 * Returns the string if it matches [a-zA-Z0-9_-]+, otherwise returns 'unknown'.
 *
 * @param {string} s - Raw class name candidate
 * @returns {string} Safe class name
 */
function safeClass(s) {
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : 'unknown'
}

/* ── Toast ── */

/**
 * Show a transient toast message. Auto-dismisses after duration ms.
 * Multiple toasts stack vertically.
 *
 * @param {string} message - Text to display
 * @param {'info'|'error'} [variant='info'] - Visual variant (sets .toast-info or .toast-error)
 * @param {number} [duration=3000] - Auto-dismiss delay in ms
 */
function showToast(message, variant = 'info', duration = 3000) {
  let stack = document.getElementById('toast-stack')
  if (!stack) {
    stack = document.createElement('div')
    stack.id = 'toast-stack'
    stack.className = 'toast-stack'
    document.body.appendChild(stack)
  }
  const toast = document.createElement('div')
  toast.className = `toast toast-${variant === 'error' ? 'error' : 'info'}`
  toast.textContent = message
  stack.appendChild(toast)
  setTimeout(() => {
    toast.classList.add('toast-leaving')
    setTimeout(() => toast.remove(), 200)
  }, duration)
}

/* ── Downloads dropdown ── */

/**
 * Initialize a downloads dropdown with async handlers and error toasts.
 *
 * Behavior:
 * - Clicking the toggle toggles `.open` class on the menu (CSS handles visibility)
 * - Clicking outside the dropdown closes it
 * - Each entry button gets a click handler that invokes entry.handler
 * - During async handlers, the button gets `data-loading="true"` (CSS handles visual)
 * - On handler rejection, shows an error toast via showToast + logs to console.error
 * - Loading state is always cleared in `finally`, even on error
 *
 * The button's innerHTML (label + hint) is preserved — loading state is purely attribute-based.
 *
 * @param {Object} config
 * @param {string} config.dropdownId - ID of the .dl-wrap container
 * @param {string} config.toggleId - ID of the .dl-toggle button
 * @param {string} config.menuId - ID of the .dl-menu panel
 * @param {Array<{id: string, label: string, hint?: string, handler: () => (Promise<void>|void)}>} config.entries
 */
function initDownloads(config) {
  const wrap = document.getElementById(config.dropdownId)
  const toggle = document.getElementById(config.toggleId)
  const menu = document.getElementById(config.menuId)
  if (!wrap || !toggle || !menu) return

  toggle.addEventListener('click', (e) => {
    e.stopPropagation()
    menu.classList.toggle('open')
  })
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) menu.classList.remove('open')
  })

  menu.innerHTML = ''
  for (const entry of config.entries) {
    const btn = document.createElement('button')
    btn.className = 'dl-item'
    btn.id = entry.id
    btn.type = 'button'
    btn.innerHTML = `${escHtml(entry.label)}${entry.hint ? `<span class="dl-hint">${escHtml(entry.hint)}</span>` : ''}`
    btn.addEventListener('click', async () => {
      btn.dataset.loading = 'true'
      try {
        await entry.handler()
      } catch (err) {
        const msg = err?.message ? err.message : String(err)
        showToast(`Download failed: ${msg}`, 'error', 5000)
        console.error('[initDownloads]', entry.id, err)
      } finally {
        delete btn.dataset.loading
      }
    })
    menu.appendChild(btn)
  }
}

/* ── Dynamic pivot seg builder ── */

/**
 * Build Col/Row segmented control buttons from a DIMS object.
 *
 * Replaces hardcoded `<button class="seg" data-v="...">` HTML in a template
 * with dynamic buttons iterating Object.entries(dims). Each dim becomes a seg
 * button; a "None" button is auto-prepended as the first option.
 *
 * **Initial active state:** controlled by the `initial` argument. Defaults to
 * `{col: 'none', row: 'none'}`. Pass `{col, row}` to restore a specific axis
 * selection — used by pivot-gallery to preserve its `Row: Batch` default, and
 * by multi-mode templates that want to rehydrate state on mode switch.
 *
 * Wires click handlers via the existing `wireSegs` pattern — clicking a button
 * toggles its `.on` class and invokes `onChange(axis, dimKey)`.
 *
 * @param {Object} dims - { key: { label: string, fn: Function, order?: string[] } }
 * @param {string} colBarId - ID of the Col .segs container
 * @param {string} rowBarId - ID of the Row .segs container
 * @param {(axis: 'col'|'row', dimKey: string) => void} onChange - Called on selection change
 * @param {{col?: string, row?: string}} [initial] - Initial active dim per axis. Defaults to none/none.
 */
function buildPivotSegsFromDims(dims, colBarId, rowBarId, onChange, initial) {
  const colBar = document.getElementById(colBarId)
  const rowBar = document.getElementById(rowBarId)
  if (!colBar || !rowBar) return

  const colActive = initial?.col || 'none'
  const rowActive = initial?.row || 'none'

  const mkSegs = (active) => {
    const parts = [`<button class="seg${active === 'none' ? ' on' : ''}" data-v="none">None</button>`]
    for (const [key, dim] of Object.entries(dims)) {
      parts.push(
        `<button class="seg${active === key ? ' on' : ''}" data-v="${escHtml(key)}">${escHtml(dim.label)}</button>`,
      )
    }
    return parts.join('')
  }

  colBar.innerHTML = mkSegs(colActive)
  rowBar.innerHTML = mkSegs(rowActive)

  wireSegs(colBarId, (v) => onChange('col', v))
  wireSegs(rowBarId, (v) => onChange('row', v))
}
