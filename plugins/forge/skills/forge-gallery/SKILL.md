---
name: forge-gallery
description: 'Create or update an image or audio gallery from HTML templates — pivot grouping, dynamic filtering, sorting, search, size controls, lightbox, multi-mode datasets, downloads dropdown. Triggers: "showcase" | "compare visually" | "gallery" | "side by side" | "create a gallery" | "show iterations" | "multi-mode gallery" | "sprite gallery".'
version: 0.4.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch
---

# Gallery — Image / Audio

Create a self-contained HTML gallery from a template. Galleries live at `~/.roxabi/forge/<project>/`.

**Read before generating:**

```
${CLAUDE_PLUGIN_ROOT}/references/forge-ops.md                       — brand detection, output paths, deploy commands
${CLAUDE_PLUGIN_ROOT}/references/aesthetics/                        — lyra.css, roxabi.css (brand tokens)
${CLAUDE_PLUGIN_ROOT}/references/diagram-meta.md                    — meta tag format + categories
${CLAUDE_PLUGIN_ROOT}/references/gallery-templates/README.md        — template guide + customisation steps
${CLAUDE_PLUGIN_ROOT}/references/gallery-templates/pivot-gallery.html — full working template
```

---

## Design Phase — Frame → Structure → Style → Deliver

Decisions made across Phases 1–4 follow this lens. It is an overlay on the procedural phases, not a separate pre-phase: Frame runs in Phase 1 (context), Structure in Phase 2 (template pick), Style in Phase 3 (customize), Deliver in Phase 4 (report + verify).

### Track selection (Phase 1 start)

Run the brand book loader (`${CLAUDE_PLUGIN_ROOT}/references/brand-book-loader.md`) before any other decision:

- **Track A (branded)** — `forge.yml` found in project `brand/` → aesthetic/palette/typography locked; `deliver_must_match` rules enforced at Deliver. Template selection is content-driven in both tracks (gallery templates serve reader-action, not brand).
- **Track B (exploration)** — no brand book → full Frame judgment.

Full track-by-track behavior: `${CLAUDE_PLUGIN_ROOT}/references/design-phase-two-track.md`.

Report the loaded brand book (or its absence) before starting Frame. Track is fixed at Phase 1 and does not change.

### Frame — What's this visual for?

Full reference: `${CLAUDE_PLUGIN_ROOT}/references/frame-phase.md` — three Frame questions, reader-action matrix, tone dimensions, example trace.

**For forge-gallery specifically, Q1 (reader-action) is the most useful prompt.** A gallery is consumed differently depending on whether the viewer is *deciding* (pick one concept) or *exploring* (browse the space). Deciding → `comparison-gallery.html` with verdict badges. Exploring → `pivot-gallery.html` or `simple-gallery.html` with filters. The same 20 images need different templates for different reader actions.

- **Track A:** ask Q1 (reader-action) and Q2 (takeaway). **Skip Q3 (tone)** — tone is pre-constrained by brand voice rules. Template is still content-driven.
- **Track B:** ask Q1, Q2, and full Q3.

Aesthetic is never chosen by Frame — it's mechanical (see `forge-ops.md § Aesthetic Detection`). Frame produces purpose, not CSS.

### Structure — Which template?

See **Phase 2 — Pick Template** below for the full template table (single source of truth). Frame's reader-action output (decide vs. explore vs. audit) maps to templates as follows:

- Deciding between spec-rich options → `comparison-gallery.html`
- Exploring 1 dimension → `simple-gallery.html`
- Exploring 2+ dimensions → `pivot-gallery.html`
- Comparing audio clips → `audio-gallery.html`
- Browsing multiple datasets → `multi-mode-gallery.html`

### Style — Which components?

| Gallery type | Toolbar | Filters | Cards |
|---|---|---|---|
| Pivot | Col/Row segs + score input | Dynamic from DIMS (auto-built) | Thumbnail + metadata |
| Simple | Batch tabs + search + size | Optional | Thumbnail |
| Comparison | Sort dropdown | None (flat) | Card with spec table |
| Audio | Engine groups | Dynamic | `<audio>` player + metadata |
| Multi-mode | Mode tabs + segs + downloads | Per-mode DIMS | Mode-specific cards |

**Ask:** Is the viewer DECIDING or EXPLORING? Deciding needs spec tables + verdict badges + a single clear recommendation. Exploring needs filters + sort + size controls + low-friction browse. If the same gallery has to serve both, build two views, not one.

### Deliver — Generate + verify

**Always** (both tracks):
- DIMS object defines all grouping dimensions.
- Filter buttons auto-built from data (not hardcoded — use `buildDimFilters`).
- Lightbox works (click → overlay, Escape to close).
- Lazy loading on all images (`loading="lazy"`).
- All images have meaningful `alt` text (fallback to filename if nothing better).
- Size controls (±) work for thumbnails (image galleries).
- Search filters visible items.
- `diagram-meta` tags present.
- Stats counter shows "visible / total".
- Interactive controls (tabs, segs, size buttons) have visible `:focus-visible` styling.
- Gallery layout reflows without horizontal scroll below 375px viewport.
- **Body copy (card labels, metadata rows) uses `var(--text)` for dark-mode readability.** `var(--text-muted)` for subtitles; `var(--text-dim)` for metadata only.

**Track A additionally:**
- Run every `brand.deliver_must_match` rule against the generated gallery HTML. Report pass/fail per rule. Do not write the file until all rules pass or the user overrides.
- If `brand.examples` list is non-empty, offer to visually compare the generated gallery against one canonical brand gallery before writing.

---

## Phase 1 — Context

1. **Ensure shared assets exist:**
   ```bash
   ls ~/.roxabi/forge/_shared/gallery-base.css ~/.roxabi/forge/_shared/gallery-base.js 2>/dev/null
   ```
   Missing → create `~/.roxabi/forge/_shared/` and copy from `${CLAUDE_PLUGIN_ROOT}/references/gallery-templates/gallery-base.{css,js}`. Continue silently.

2. **Detect project** from ARGS or cwd.
3. **Detect gallery type** from ARGS: image or audio.
4. **Gallery slug** (kebab-case) from ARGS.
5. **Check existing:** offer to add batch or start fresh.
6. **Run the brand book loader** (`${CLAUDE_PLUGIN_ROOT}/references/brand-book-loader.md`): Discovery → Parse → Apply. Determine Track A or Track B. Report the result before continuing.
7. **Check for data JSON** (`face-scores.json` etc.) — enables score/cluster filtering.

---

## Phase 2 — Pick Template

Read `${CLAUDE_PLUGIN_ROOT}/references/gallery-templates/README.md` for the full list.

| Need | Template | Key features |
|------|----------|-------------|
| Image comparison with scoring | `pivot-gallery.html` | Pivot matrix, dynamic filters, sort, search, size, lightbox |
| Basic batch comparison | `simple-gallery.html` | Batch tabs, lightbox, search, size |
| Side-by-side with specs | `comparison-gallery.html` | Cards with metadata tables |
| Audio/voice comparison | `audio-gallery.html` | Audio players, engine grouping |
| **Multi-dataset / multi-mode** | **`multi-mode-gallery.html`** | **Mode tabs, per-mode DIMS, dynamic pivot segs, downloads dropdown, sprite/pixel support** |

Copy the chosen template to `~/.roxabi/forge/{PROJ}/{SLUG}.html`.

### When to use items-as-objects vs filename-strings

`buildDimFilters` and `applyDimFilters` are **dual-API** — each element of the `items` array is passed verbatim to `dim.fn`. You pick the representation:

- **Filename-strings** — each item is a string, `dim.fn` parses substrings. Fast to set up, no item-building pipeline. Used by `pivot-gallery.html`. Good when filenames already encode all metadata and there's one dataset.
- **Items-as-objects** — each item is `{file, dir, label, ...custom fields}`, `dim.fn` reads fields directly (e.g. `it => it.rarity`). Cleaner for multiple dimensions, multiple modes, or data composed from multiple sources. Used by `comparison-gallery.html`, `audio-gallery.html`, `multi-mode-gallery.html`.

For multi-mode galleries, always use items-as-objects — each mode's dims read different fields from the same item shape. See the gallery-templates README § "Items-as-objects vs filename-strings" for worked examples.

---

## Phase 3 — Customise

Follow the steps in the template's README:

### 1. Fill `{{PLACEHOLDERS}}`

Replace all `{{...}}` in the HTML: title, date, subtitle, image directory, data JSON path, reference image.

### 2. Define dimensions (`DIMS` object)

Each dimension = a way to classify images. Add one entry per grouping axis:

```javascript
const DIMS = {
  batch: {
    label: 'Batch',
    fn: f => f[0],              // how to extract category from filename
    order: ['A','B','C','D'],   // sort order (optional)
  },
  // Add more: score, shot, cluster, etc.
};
```

Values are **auto-discovered** from data — the template creates filter buttons with counts automatically. No hardcoded button lists.

### 3. Pivot seg buttons — prefer dynamic construction

**Modern approach** (`pivot-gallery.html`, `multi-mode-gallery.html`): leave the Col/Row `<div class="segs">` containers empty and call `buildPivotSegsFromDims(DIMS, 'colSegs', 'rowSegs', onChange, initial?)` at boot. The helper iterates `Object.entries(dims)` and builds the buttons automatically. Add a new DIMS key and the button appears — no HTML sync needed.

**Legacy approach** (other templates): for each DIMS key, add a `<button class="seg" data-v="KEY">Label</button>` in both the Col and Row segmented controls manually. Kept for compat with existing galleries — new templates should use the helper.

### 4. Remove unused features

- No reference image → delete `<div class="ref">`
- No score data → set `DATA_URL = null`, remove score dim
- No pivot → remove Col/Row controls (defaults to flat grid)

### 5. Update brand tokens

Replace CSS custom properties in `:root` with project tokens from `tokens.md`.

---

## Phase 4 — Report

```
Created: ~/.roxabi/forge/{PROJ}/{SLUG}.html
Template: {template name}

Serve + Deploy: see forge-ops.md
```

---

## Key patterns (reference)

These are implemented in the templates. Read the template source for details.

**Filter logic:** All buttons OFF = filter inactive = show everything. Clicking a button activates that dimension. This is opt-in filtering, not opt-out.

**Three rendering modes:**
- Both Col/Row = None → flat grid
- One axis set → grouped list with section headers
- Both axes set → pivot matrix table with sticky headers

**Dynamic filter builder:** At load time, scans all files through each DIMS function, discovers unique values, creates toggle buttons with counts. No hardcoded values.

**Data-driven enrichment:** When a JSON file exists (scores, clusters), the template loads it and enables score sorting/filtering and cluster grouping as additional dimensions.

**Image discovery:** manifest.json (Cloudflare) → /api/list/ fallback (local dev) → data JSON keys fallback.

---

## Feature checklist

Every gallery MUST include:

| Feature | Required | Notes |
|---------|----------|-------|
| Image discovery | ✅ | manifest.json + API fallback |
| Lightbox | ✅ | Click → full-size overlay, Escape to close |
| Lazy loading | ✅ | `loading="lazy"` on all images |
| diagram-meta | ✅ | Standard meta tags |
| Brand tokens | ✅ | From tokens.md |
| **Sort controls** | ✅ | Score ↓/↑, Name |
| **Search** | ✅ | Text filter on filenames |
| **Size +/−** | ✅ (image) | 40–200px thumbnail adjustment |
| **Stats counter** | ✅ | "visible / total" |
| **Dynamic filters** | ✅ | Auto-built from DIMS, OFF by default |
| Pivot grouping | When ≥2 dimensions | Col/Row segmented controls |
| Score filtering | When data JSON exists | Min score input |
| Starring | Optional | localStorage persistence |

$ARGUMENTS
