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

All templates share:
- **`gallery-base.css`** — shared CSS foundation (tokens, resets, header, toolbar, controls, stats, group headers, empty state, responsive). Each template links to it and adds template-specific styles inline.
- **`gallery-base.js`** — shared JS utilities: `initTheme()`, `buildDimFilters()`, `applyDimFilters()`, `wireSegs()`, `discoverBatch()`, `discoverFiles()`, `buildBatchBar()`, `initStarred()`. Each template loads it and uses these instead of inline duplicates.
- Same CSS token system (`:root` variables from `tokens.md`) — override `--accent` / `--accent-dim` per project
- Same toolbar pattern (`.toolbar > .ctrl > .ctrl-label + .segs/.check-group`)
- Dynamic filters (OFF by default = inactive = show everything)
- Search, sort, size +/−, stats counter, lightbox
- manifest.json + /api/list/ discovery
- `{{PLACEHOLDER}}` markers + `CUSTOMISE` comment sections

**Deploy path:** copy `gallery-base.css` and `gallery-base.js` to `~/.roxabi/forge/_shared/`. Gallery HTMLs link to them via relative path (e.g. `../../_shared/gallery-base.css`, `../../_shared/gallery-base.js`).

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
cd ~/projects/lyra-stack && make forge deploy
```

## How to customise `simple-gallery.html`

Best for iterative exploration (V1 → V2 → V3 batches) with starring.

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
