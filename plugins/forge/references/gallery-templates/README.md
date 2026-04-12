# Gallery Templates

Working HTML templates for the `forge-gallery` skill. Copy the right template, fill in the `{{PLACEHOLDERS}}`, and customise the `DIMS` object.

## Showcase

### Pivot Gallery
> Matrix view with row×column grouping. Score-based filtering and sorting.

```
┌─────────────────────────────────────────────────────────────────┐
│  Col [None|Batch|Score|Shot]   Row [None|Batch|Score|Shot]      │
│  Sort [Score↓|Score↑|Name]    Size [−] 80 [+]                  │
│  Batch ( A ) ( B ) ( C ) ( D )   Min score [0.00]   Search [  ]│
├──────────┬──────────┬──────────┬──────────┬─────────────────────┤
│          │  >0.50   │ 0.40-0.50│ 0.30-0.40│  <0.30             │
├──────────┼──────────┼──────────┼──────────┼─────────────────────┤
│ A        │ ▪▪▪      │ ▪▪▪▪▪▪▪ │ ▪▪▪▪▪▪▪▪ │ ▪▪▪▪               │
│ B        │ ▪▪▪▪     │ ▪▪▪▪▪▪  │ ▪▪▪▪▪▪▪▪ │ ▪▪▪                │
│ C        │ ▪▪▪      │ ▪▪▪▪▪▪▪▪│ ▪▪▪▪▪▪▪  │ ▪▪                 │
│ D        │ ▪▪▪▪     │ ▪▪▪▪▪▪  │ ▪▪▪▪▪▪▪▪ │ ▪▪▪▪               │
└──────────┴──────────┴──────────┴──────────┴─────────────────────┘
  Live: diagrams.roxabi.com/lyra/brand/v20-gallery.html
```

### Simple Gallery
> Batch tabs with starring, tag filtering, lightbox navigation.

```
┌─────────────────────────────────────────────────────────────────┐
│  [ALL (74)] [V1 — Exploration (38)] [V2 — Refinement (36)]     │
│  Sort [Default|Name]   Size [−] 80 [+]   Search [    ]         │
│  Tags: (studio) (calm) (smile) (3q) (frontal)   ★ Starred (5)  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐        │
│  │ ▪ ★ │  │ ▪   │  │ ▪   │  │ ▪ ★ │  │ ▪   │  │ ▪   │        │
│  │ V1  │  │ V1  │  │ V2  │  │ V2  │  │ V1  │  │ V2  │        │
│  └─────┘  └─────┘  └─────┘  └─────┘  └─────┘  └─────┘        │
│  74 / 74                                                        │
└─────────────────────────────────────────────────────────────────┘
  Live: diagrams.roxabi.com/lyra/brand/avatar-gallery.html
```

### Comparison Gallery
> Cards with spec tables and verdict badges for pipeline evaluation.

```
┌─────────────────────────────────────────────────────────────────┐
│  Sort [Default|Title]   Size [−] 350 [+]   Search [    ]       │
│  Tags: (clean) (pulid) (banding) (no-pulid)                    │
├─────────────────────────────────────────────────────────────────┤
│  ── Pipeline Comparison ──                                      │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────┐             │
│  │       [image]        │  │       [image]        │             │
│  │ Klein 4B — 28 Steps  │  │ FLUX.1-dev + PuLID   │             │
│  │ ┌──────────────────┐ │  │ ┌──────────────────┐ │             │
│  │ │Engine  flux2-klein│ │  │ │Engine  flux1-dev │ │             │
│  │ │Steps   28        │ │  │ │Steps   24        │ │             │
│  │ │VRAM    7.84 GB   │ │  │ │VRAM    10.19 GB  │ │             │
│  │ └──────────────────┘ │  │ └──────────────────┘ │             │
│  │ ✅ Clean, no banding │  │ ✅ Face locked       │             │
│  └──────────────────────┘  └──────────────────────┘             │
└─────────────────────────────────────────────────────────────────┘
  Live: diagrams.roxabi.com/lyra/brand/1024-comparison.html
```

### Audio Gallery
> Audio players with engine badges, grouping, card/list toggle.

```
┌─────────────────────────────────────────────────────────────────┐
│  Group [Engine|Quality|None]   View [Cards|List]                │
│  Sort [Default|Name]   Size [−] 300 [+]   Search [    ]        │
│  Engine: (chatterbox) (voxtral) (whisper)                       │
├─────────────────────────────────────────────────────────────────┤
│  ── Chatterbox ──                                               │
│                                                                  │
│  ┌──────────────────────────┐  ┌──────────────────────────┐     │
│  │ Sample 1                 │  │ Sample 2                 │     │
│  │ ▶ ━━━━━━━━━━━━━━━ 0:03  │  │ ▶ ━━━━━━━━━━━━━━━ 0:05  │     │
│  │ [Chatterbox] [q8] [v2]  │  │ [Chatterbox] [q8] [v2]  │     │
│  └──────────────────────────┘  └──────────────────────────┘     │
│                                                                  │
│  ── Voxtral ──                                                  │
│  ...                                                            │
└─────────────────────────────────────────────────────────────────┘
  Live: diagrams.roxabi.com/voicecli/engine-compare/engine-compare.html
```

---

## Templates

| Template | When to use | Size | Key features |
|----------|------------|------|-------------|
| `pivot-gallery.html` | Image comparison with scoring/clustering data | 23K | Pivot matrix (col×row), dynamic filters, sort, search, size +/−, lightbox |
| `simple-gallery.html` | Batch-based image gallery (V1/V2 iterations) | 27K | BATCHES tabs, starring, tag filters, search, sort, size +/−, lightbox with nav |
| `comparison-gallery.html` | Side-by-side cards with detailed specs | 25K | CARDS array config, spec tables, verdict badges, filters, search, size +/− |
| `audio-gallery.html` | Audio/voice engine comparison | 37K | Audio players, engine/quality badges, grouping, card/list view, starring |
| `multi-mode-gallery.html` | Multi-dataset galleries (modes/tabs) with per-mode dimensions | ~20K | Mode tab bar, per-mode DIMS, dynamic pivot segs, downloads dropdown, items-as-objects, pixel-art support |

All templates share:
- **`gallery-base.css`** — shared CSS foundation (tokens, resets, header, toolbar, controls, stats, group headers, empty state, responsive, plus `.pixelated`, `.dl-wrap`/`.dl-menu`, `.toast` utilities). Each template links to it and adds template-specific styles inline.
- **`gallery-base.js`** — shared JS utilities: `initTheme()`, `buildDimFilters()`, `applyDimFilters()`, `wireSegs()`, `discoverFiles()`, `discoverDirs()`, `discoverBatch()`, `buildBatchBar()`, `initStarred()`, `buildPivotSegsFromDims()`, `initDownloads()`, `showToast()`, `escHtml()`, `safeClass()`. Each template loads it and uses these instead of inline duplicates.
- Same CSS token system (`:root` variables from `tokens.md`) — override `--accent` / `--accent-dim` per project
- Same toolbar pattern (`.toolbar > .ctrl > .ctrl-label + .segs/.check-group`)
- Dynamic filters (OFF by default = inactive = show everything)
- Search, sort, size +/−, stats counter, lightbox
- manifest.json + /api/list/ discovery
- `{{PLACEHOLDER}}` markers for all customisation points

**Asset path placeholders:** all templates use `{{GALLERY_BASE_CSS}}` and `{{GALLERY_BASE_JS}}` for the shared asset paths. Replace with the correct relative path for your deploy location (e.g. `../../_shared/gallery-base.css`, `../../_shared/gallery-base.js`).

**Deploy path:** copy `gallery-base.css` and `gallery-base.js` to `~/.roxabi/forge/_shared/`.

## How to customise `pivot-gallery.html`

### Step 1 — Fill placeholders

| Placeholder | Example | Where |
|------------|---------|-------|
| `{{TITLE}}` | `V20 — Pivot Gallery` | `<title>`, `<h1>`, diagram-meta |
| `{{DATE}}` | `2026-04-02` | diagram-meta |
| `{{COLOR}}` | `#e85d04` | diagram-meta |
| `{{SUBTITLE}}` | `400 images · Klein 4B · 512×512` | `<p class="sub">` |
| `{{REF_IMAGE_PATH}}` | `concepts/avatar-final/006.png` | Reference image src |
| `{{REF_LABEL}}` | `Ref: 006` | Reference caption |
| `{{IMAGE_DIR}}` | `concepts/avatar-lyra-v20/` | JS `DIR` constant |
| `{{DATA_JSON_PATH}}` | `DIR + 'face-scores.json'` or `null` | JS `DATA_URL` constant |

### Step 2 — Define dimensions (the `DIMS` object)

Each dimension is a way to slice the images. The template discovers values automatically — you just provide the classification function.

```javascript
const DIMS = {
  // key: must match data-v in the pivot seg buttons
  batch: {
    label: 'Batch',           // shown on filter buttons
    fn: f => f[0],            // filename → category string
    order: ['A','B','C','D'], // preferred sort (optional)
  },
  score: {
    label: 'Score',
    fn: f => {
      const s = scores[f];
      if (s > 0.5) return '>0.50';
      if (s > 0.4) return '0.40–0.50';
      return '<0.40';
    },
    order: ['>0.50', '0.40–0.50', '<0.40'],
  },
};
```

**Rules for `fn`:**
- Takes a filename like `"A-001.png"`
- Returns a string category
- Unknown/unmatched → return `'other'` (it will appear as a filter button)

**Rules for `order`:**
- Optional array of strings matching `fn` return values
- Controls sort order in pivot headers and filter buttons
- Values not in `order` are appended alphabetically

### Step 3 — Add/remove pivot seg buttons

The pivot controls in the HTML must match `DIMS` keys:

```html
<button class="seg" data-v="batch">Batch</button>   <!-- matches DIMS.batch -->
<button class="seg" data-v="score">Score</button>   <!-- matches DIMS.score -->
<button class="seg" data-v="cluster">Cluster</button> <!-- only if DIMS.cluster exists -->
```

Add a `<button class="seg" data-v="KEY">Label</button>` for each dimension you define.

### Step 4 — Remove what you don't need

- **No reference image?** Delete the `<div class="ref">` block.
- **No score data?** Set `DATA_URL = null`, remove `score` from DIMS, remove min-score input.
- **No pivot needed?** Remove Col/Row seg controls. Gallery defaults to flat grid.
- **No search?** Remove the search input. (But why would you?)

### Step 5 — Deploy

```bash
# Copy template to project location
cp pivot-gallery.html ~/.roxabi/forge/{project}/{slug}.html

# Edit placeholders + DIMS

# Deploy
cd ~/projects && make forge deploy
```

## How to customise `simple-gallery.html`

Best for iterative exploration (V1 → V2 → V3 batches) with starring.

### Generated batches — enriched manifest (no hardcoded CATALOGUE)

When images are script-generated (e.g. `generate_prompts.py` producing 2000+ images), the
`manifest.json` inside the image dir carries `label` and `tags` per entry. `discoverBatch`
reads them directly — no `CATALOGUE_VNN` object needed:

```javascript
const BATCHES = [
  // Hand-curated batch — static catalogue
  { id:'v1', label:'V1 Exploration', dir:'concepts/avatar-v1/', catalogue: CATALOGUE_V1 },
  // Generated batch — enriched manifest, no catalogue
  { id:'vNNN', label:'V24 — 2000 images', dir:'concepts/avatar-vNNN/' },
];
```

The enriched `manifest.json` format (written by `generate_prompts.py`):
```json
[
  { "name": "P0012.png", "label": "Headshot · Three-quarter right · Soft smirk · Studio · Dark",
    "tags": ["headshot", "3Q-right", "soft-smirk", "studio", "dark"], "size": 0, "mtime": 0 }
]
```

`discoverBatch` checks `f.label !== undefined || f.tags !== undefined` on each entry and short-circuits
the catalogue lookup when the manifest is enriched. Backwards-compatible: non-enriched manifests
(`{name, size, mtime}` only) continue to use `catalogue?.[stem]` as before.

**Rule:** use enriched manifest for any batch where the label/tags are derivable from prompt axes.
Use a static `CATALOGUE` only for hand-curated batches where you want custom labels or tags that
can't be inferred from filenames.

### Key config objects:

```javascript
// BATCHES — one entry per generation round
const BATCHES = [
  { id:'v1', label:'Exploration', dir:'concepts/v1/', catalogue: CATALOGUE_V1 },
  { id:'v2', label:'Refinement',  dir:'concepts/v2/', catalogue: CATALOGUE_V2 },
];

// CATALOGUE — per-image labels and tags (optional)
const CATALOGUE_V1 = {
  '001-frontal-calm': { label:'Frontal · Calm', tags:['studio','calm','frontal'] },
};
```

### What to customise:
1. Fill `{{PLACEHOLDERS}}`: title, accent color, BATCHES, catalogues
2. Starring key: `{{STORE_KEY_PREFIX}}` → e.g. `lyra-avatar`
3. DIMS: add tag-based dimensions if your catalogue has tags
4. Add/remove batch tab buttons (auto-generated from BATCHES)

## How to customise `comparison-gallery.html`

Best for detailed pipeline comparison (A vs B vs C with specs).

### Key config objects:

```javascript
// SECTIONS — group headings
const SECTIONS = [
  { id:'pipelines', title:'Pipeline Comparison', subtitle:'Same prompt, different engines' },
  { id:'tuning', title:'PuLID Tuning', subtitle:'Strength and scale variations' },
];

// CARDS — one per image, all rendered from JS
const CARDS = [
  {
    section: 'pipelines',
    image: 'concepts/dir/image.png',
    title: 'Klein 4B — 28 Steps',
    badges: [{ text:'CLEAN', type:'clean' }, { text:'NO PULID', type:'a' }],
    specs: { Engine:'flux2-klein', Steps:'28', 'Peak VRAM':'7.84 GB' },
    verdict: { text:'Clean output, best quality.', type:'clean' },
    tags: ['klein', 'clean'],
  },
];
```

### What to customise:
1. Fill sections and cards arrays
2. Badge types: `clean` (green), `bad` (red), `mid` (amber), `ref` (blue), `a`-`d` (per-group colors)
3. Verdict types: `clean`, `bad`, `mid`
4. FILTERS_DIMS: auto-discovers from card tags/badges

## How to customise `audio-gallery.html`

Best for TTS engine comparison, voice cloning, audio A/B tests.

### Key config objects:

```javascript
// ENGINE_META — badge colors per engine
const ENGINE_META = {
  'chatterbox': { color:'#e85d04', label:'Chatterbox' },
  'voxtral':    { color:'#60a5fa', label:'Voxtral' },
};

// BATCHES — audio directories
const BATCHES = [
  { id:'baseline', label:'Baseline', dir:'audio/baseline/', ext:'.mp3' },
  { id:'clone',    label:'Voice Clone', dir:'audio/clone/',   ext:'.wav' },
];
```

### What to customise:
1. ENGINE_META: one entry per engine/source with badge color
2. BATCHES: audio directories and file extensions
3. `itemMeta(item)`: how to extract engine/quality from filename
4. Grouping options: by engine, quality, batch, or none
5. Card vs list view toggle

---

## How filters work

**All buttons OFF = filter inactive = show everything.**

When the user clicks a button, that dimension's filter activates and only shows matching images. This is the opposite of "all ON by default" — it means opening the gallery shows all images, and filters are opt-in.

Filters are auto-generated from data at load time. Each dimension discovers its unique values and creates buttons with counts. If an image has no value for a dimension, it appears under the `'other'` category.

## How the pivot works

| Col \ Row | Setting | Result |
|-----------|---------|--------|
| None | None | Flat grid of all images |
| None | Batch | Grouped by batch (sections with headers) |
| Batch | None | Columns per batch, single row |
| Batch | Score | Full matrix: batches × score ranges |
| Score | Batch | Transposed matrix |

The matrix cells contain thumbnails. Size is controlled by the +/− buttons. Sorting applies within each cell.

---

## How to customise `multi-mode-gallery.html`

Best for galleries with **multiple independent datasets** — each mode has its own dimensions (pivot axes), its own item-building function, and its own display settings. PI Buddy's sprite gallery is the reference consumer: Baby Showcase 512×512 · Full Set 256×256 · Production 32×32, each with distinct dim combinations (rarity × style for Baby; rarity × stage × species for Full Set).

### Step 1 — Fill placeholders

| Placeholder | Example | Where |
|-------------|---------|-------|
| `{{TITLE}}` | `PI Buddy — Sprite Gallery` | `<title>`, diagram-meta |
| `{{TITLE_PLAIN}}` | `PI Buddy` | First part of `<h1>` (neutral color) |
| `{{TITLE_ACCENT}}` | `Sprite Gallery` | Second part of `<h1>` (accent-colored span) |
| `{{DATE}}` | `2026-04-04` | diagram-meta |
| `{{COLOR}}` | `purple` | diagram-meta (semantic color name) |
| `{{ACCENT_COLOR}}` | `#a78bfa` | CSS `--accent` custom property |
| `{{ACCENT_DIM}}` | `rgba(167,139,250,0.12)` | CSS `--accent-dim` custom property |
| `{{SUBTITLE}}` | `24 species · 3 modes · 360 images` | `<div class="sub">` header subtitle |
| `{{STORE_KEY_PREFIX}}` | `pi-buddy-gallery` | localStorage key prefix for theme + starring |

If `{{STORE_KEY_PREFIX}}` is left unsubstituted, the template falls back to `'multi-mode-gallery'` at runtime to avoid polluting localStorage with literal brace syntax — but you should always substitute it to avoid collisions with other galleries on the same origin.

### Step 2 — Define `MODES`

Each mode entry owns its own dims + items:

```javascript
const MODES = [
  {
    id: 'baby',
    label: 'Baby Showcase',
    countLabel: '512px',
    dir: 'images/baby/',
    pixelated: false,
    dims: {
      rarity: { label: 'Rarity', fn: it => it.rarity, order: ['common','rare','epic'] },
      style:  { label: 'Style',  fn: it => it.style,  order: ['gbc','snes','modern'] },
    },
    buildItems: () => [
      { file: '01-blob-baby-gbc.png', dir: 'images/baby/', label: 'Blob', rarity: 'common', style: 'gbc' },
      // ...
    ],
  },
  // ...more modes
];
```

### Step 3 — Atomic mode switch

`switchMode(newMode)` runs an **8-step atomic sequence** that MUST be preserved when you customize it:

```javascript
function switchMode(newMode) {
  activeMode = newMode                                           // 1
  filters = {}                                                   // 2 — reset stale dim keys
  colDim = 'none'                                                // 3
  rowDim = 'none'                                                // 4
  visibleItems = []                                              // 5 — reset lightbox state
  items = getActiveMode().buildItems()
  buildPivotSegsFromDims(getActiveMode().dims, 'colSegs', 'rowSegs', onPivotChange)  // 6
  document.getElementById('filterBar').innerHTML = '/* search input markup */'       // 7 — clear old .check-btn state
  buildDimFilters(items, getActiveMode().dims, filters, 'filterBar', render)         // 7 cont.
  render()                                                       // 8
}
```

**⚠ Do not skip any step.** Omitting the filter reset (step 2) or the filterBar innerHTML clear (step 7) causes the **stale-key / stale-UI bug**: old filter state carries into the new mode and UI buttons show the wrong active state. Dim-key collisions between modes with different value vocabularies can produce wrong filter results.

### Step 4 — Configure downloads (optional)

See "Downloads dropdown helper" below. Leave the `entries: [...]` array empty to hide the dropdown.

### Step 5 — Sprite/pixel-art rendering

Set `pixelated: true` on a mode's config to apply `image-rendering: pixelated` to all thumbs + lightbox image. Use with NEAREST-scale downsamples for crisp retro sprite rendering.

---

## Items-as-objects vs filename-strings

`buildDimFilters` and `applyDimFilters` are **dual-API** — they pass each element of the `items` array to `dim.fn` verbatim, without inspecting the type. This lets you choose between two representations:

### Filename-strings (simple)

Each item is a string (typically a filename). `dim.fn` parses the string to extract a category. Used by `pivot-gallery.html`.

```javascript
const items = ['A-001.png', 'A-002.png', 'B-001.png']

const DIMS = {
  batch: { label: 'Batch', fn: f => f[0] },  // 'A' or 'B'
}

buildDimFilters(items, DIMS, filters, 'filterBar', render)
```

**Use when:** filenames already encode all the metadata you need, there's one dataset, and you don't want to build an item-object pipeline.

### Items-as-objects (structured)

Each item is an object with explicit fields. `dim.fn` reads fields directly. Used by `comparison-gallery.html`, `audio-gallery.html`, `multi-mode-gallery.html`.

```javascript
const items = [
  { file: '01-blob.png', species: 'blob', rarity: 'common', stage: 'baby' },
  { file: '02-wisp.png', species: 'wisp', rarity: 'common', stage: 'adult' },
]

const DIMS = {
  rarity: { label: 'Rarity', fn: it => it.rarity },
  stage:  { label: 'Stage',  fn: it => it.stage  },
}

buildDimFilters(items, DIMS, filters, 'filterBar', render)
```

**Use when:** you have multiple dimensions, need custom display labels, plan to support multiple modes, or want to compose items from multiple data sources (e.g. manifest + scores JSON).

### Dynamic subdirectory discovery (`discoverDirs`)

When a gallery has a **parent dir containing one subdir per group** — LoRA variants, training runs, engine checkpoints, prompt batches — hardcoding the group list means every new variant added to disk is silently ignored. Use `discoverDirs(dir)` to enumerate subdirs at load time.

**API**

```javascript
const subdirs = await discoverDirs('concepts/avatar-lyra-benchmark/')
// → ['v22_face', 'v22_island0', 'v22_top30', 'v23d_2000', …, 'v23f_4000']
```

Symmetric with `discoverFiles`: tries `{dir}/manifest.json` first (static hosts), then `/api/list/{dir}` (forge dev server). Manifest entries must have `is_dir: true` to be treated as directories. Returns sorted array of names, `[]` if neither path resolves.

**Static-hosting requirement.** On static hosts (Cloudflare Pages, file://), the parent dir needs a `manifest.json` listing its subdirs. The `gen-image-manifests.py` build step writes these automatically at every directory level whose subtree contains image files — no manual curation needed.

**Worked example — two-level gallery with metadata overlay**

The pattern: declare metadata for *known* groups (labels, badges, display order) and let `discoverDirs` find everything on disk. Unknown groups (added after the gallery was written) fall back to a default style and append alphabetically after the known ones — so new variants just show up.

```javascript
const DIR = 'concepts/avatar-lyra-benchmark/'
const EXT = '.png'

// Canonical order + per-group metadata. Keys define display order; dirs
// discovered on disk but absent from this map append alphabetically after.
const LORA_META = {
  v22_top30:   { version: 'v22', label: 'top30 baseline',   baseline: true },
  v22_island0: { version: 'v22', label: 'island0 baseline', baseline: true },
  v23d_2000:   { version: 'v23' },
  v23d_2500:   { version: 'v23' },
  v23d_3000:   { version: 'v23' },
}

function inferMeta(name) {
  if (name.startsWith('v22_')) return { version: 'v22' }
  if (name.startsWith('v23')) return { version: 'v23' }
  return {}
}
const getMeta = (name) => LORA_META[name] || inferMeta(name)

// Mutable array — DIMS.lora.order keeps a reference to this, so mutating
// in place (push) updates the dim ordering without reassignment.
const LORAS = []

const DIMS = {
  lora: { label: 'LoRA', fn: getLora, order: LORAS },
  // …
}

async function boot() {
  const discovered = await discoverDirs(DIR)
  const known = Object.keys(LORA_META).filter((k) => discovered.includes(k))
  const extra = discovered.filter((k) => !LORA_META[k]).sort()
  LORAS.push(...known, ...extra)

  buildLoraStrip() // build pills dynamically from LORAS + getMeta
  allFiles = await discoverAllLoras() // iterate LORAS, discoverFiles per subdir
  buildDimFilters(allFiles, DIMS, filters, 'filterBar', render)
  render()
}
```

**Key rules:**
- Use `const LORAS = []` + `LORAS.push(...)` — **never** `let LORAS = []; LORAS = [...]`. Reassignment breaks the reference captured by `DIMS.lora.order`.
- Build pill/badge HTML from the populated array in JS (`strip.innerHTML = LORAS.map(...)`) — hardcoded HTML pills leave newly-discovered groups without an element to update.
- When updating pill text after file discovery, store the base text in `dataset.baseText` on first write so re-renders can rebuild `base + ' · ' + count` instead of appending. `pill.textContent += …` is an anti-pattern — it duplicates on re-run.
- Existing galleries using this pattern: `~/.roxabi/forge/lyra/brand/v23-gallery.html`, `v23-benchmark-gallery.html`.

### Legacy wrapper pattern (avoid in new code)

`simple-gallery.html` uses an older `DIMS_WRAPPED` indirection where `dim.fn` takes `item.tags` (a subfield) instead of the full item:

```javascript
// LEGACY — do not copy into new galleries
const DIMS_WRAPPED = {}
for (const [k, dim] of Object.entries(DIMS)) {
  DIMS_WRAPPED[k] = { ...dim, fn: item => dim.fn(item.tags) }
}
```

New galleries should define `dim.fn` to read from the item directly (e.g. `fn: it => it.tags[0]`) and skip the wrapper. The wrapper exists only because simple-gallery predates the formal dual-API contract.

---

## Incremental upgrade path — single-mode to multi-mode

If you have an existing `pivot-gallery.html`-based gallery and want to add a second mode (or just adopt the helpers) without rewriting from scratch, follow these **5 steps**:

1. **Wrap existing data in a `MODES` array** with one entry:
   ```javascript
   const MODES = [{
     id: 'main', label: 'Main', dims: DIMS, buildItems: () => currentItems,
   }]
   ```

2. **Add the mode tab bar markup** above your existing toolbar:
   ```html
   <div class="mode-bar" id="modeBar"></div>
   ```

3. **Replace hardcoded Col/Row seg buttons** with empty containers and a helper call. Before:
   ```html
   <div class="segs" id="colSegs">
     <button class="seg on" data-v="none">None</button>
     <button class="seg" data-v="batch">Batch</button>
   </div>
   ```
   After:
   ```html
   <div class="segs" id="colSegs"></div>
   ```
   ```javascript
   buildPivotSegsFromDims(DIMS, 'colSegs', 'rowSegs', onPivotChange, { col: 'none', row: 'batch' })
   ```

4. **Add the atomic `switchMode` sequence** (see "How to customise multi-mode-gallery.html" above). **⚠ Must include all 8 steps** — skipping any causes stale-key/stale-UI bugs.

5. **Add a second mode entry** to `MODES` when ready. Mode tab bar rebuilds automatically. No other code changes required.

---

## Dynamic pivot seg construction

Use `buildPivotSegsFromDims` to avoid hardcoding Col/Row seg buttons that must be manually kept in sync with DIMS keys.

```javascript
buildPivotSegsFromDims(
  dims,                       // your DIMS object
  'colSegs',                  // id of Col .segs container (empty div)
  'rowSegs',                  // id of Row .segs container (empty div)
  (axis, dimKey) => {         // called on button click
    if (axis === 'col') colDim = dimKey
    else rowDim = dimKey
    render()
  },
  { col: 'none', row: 'batch' }  // optional: initial active dim per axis
)
```

The function:
- Auto-prepends a "None" button (active by default unless `initial` says otherwise)
- Appends one button per `Object.entries(dims)`, labeled with `dim.label`
- Resets active state on every call — caller restores via `initial` parameter if needed
- Wires click handlers via existing `wireSegs` (handles `.on` toggling)

Add a new dim to `DIMS` and the button appears automatically — no HTML sync required.

---

## Downloads dropdown helper

`initDownloads` wires a downloads dropdown with async handlers, automatic loading state, and error toasts. Use for playbook downloads, prompt bundles, or lazy-loaded JSZip image archives.

### HTML markup

```html
<div class="dl-wrap" id="dlWrap">
  <button class="dl-toggle" id="dlToggle" type="button">&#x2B73; Downloads</button>
  <div class="dl-menu" id="dlMenu"></div>
</div>
```

### JavaScript configuration

```javascript
initDownloads({
  dropdownId: 'dlWrap',
  toggleId: 'dlToggle',
  menuId: 'dlMenu',
  entries: [
    {
      id: 'dlPlaybook',
      label: '⬇ Playbook',
      hint: 'Project README / docs',
      handler: async () => {
        const r = await fetch('README.md')
        if (!r.ok) throw new Error(r.status)
        triggerDownload(await r.blob(), 'README.md')
      },
    },
    // Add more entries
  ],
})
```

### Async handlers + loading state

Each entry's `handler` can be async. While it's running, the button's `data-loading="true"` attribute is set (CSS adds a spinner + dims the button). On rejection, a toast is automatically shown via `showToast` and the error is logged to console. The button's label/hint text is never mutated.

### CSP directive (important)

If your `handler` lazy-loads libraries from a CDN (e.g. JSZip), your site's Content-Security-Policy **must** allow the CDN:

```
script-src 'self' https://cdn.jsdelivr.net;
```

Without this directive, the dynamic `<script>` load fails and `initDownloads` surfaces a toast: *"Download failed: JSZip blocked by CSP"*. Deploy your gallery with the directive in place, or host the library alongside the gallery and load it directly.

---

## Pixel-art rendering

Sprite galleries (32×32, 64×64, buddy creatures, retro game assets) need `image-rendering: pixelated` to disable browser smoothing. The `.pixelated` utility class in `gallery-base.css` handles this with vendor fallbacks:

```css
.pixelated {
  image-rendering: pixelated;
  image-rendering: -moz-crisp-edges;
  image-rendering: crisp-edges;
}
```

Apply to `<img>` elements in sprite galleries. In `multi-mode-gallery.html`, set `pixelated: true` on a mode's config and the class is added to all thumbs + lightbox image automatically.

Pair with a NEAREST-resample downscale pipeline (e.g. `PIL.Image.resize((32,32), Image.NEAREST)`) for best results — linear/bilinear downsamples blur the pixels before the CSS can help.
