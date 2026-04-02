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
 * @param {Array} items - Data array to scan (objects, strings, anything dim.fn accepts)
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
 * @param {Array} items - Items to filter
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
