---
name: forge-gallery
description: 'Create or update an image or audio gallery from HTML templates — pivot grouping, dynamic filtering, sorting, search, size controls, lightbox. Triggers: "showcase" | "compare visually" | "gallery" | "side by side" | "create a gallery" | "show iterations".'
version: 0.3.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch
---

# Gallery — Image / Audio

Create a self-contained HTML gallery from a template. Galleries live at `~/.roxabi/forge/<project>/`.

**Read before generating:**

```
${CLAUDE_PLUGIN_ROOT}/references/tokens.md                          — CSS tokens + dark mode rules
${CLAUDE_PLUGIN_ROOT}/references/diagram-meta.md                    — meta tag format + categories
${CLAUDE_PLUGIN_ROOT}/references/gallery-templates/README.md        — template guide + customisation steps
${CLAUDE_PLUGIN_ROOT}/references/gallery-templates/pivot-gallery.html — full working template
```

---

## Phase 1 — Context

1. **Detect project** from ARGS or cwd.
2. **Detect gallery type** from ARGS: image or audio.
3. **Gallery slug** (kebab-case) from ARGS.
4. **Check existing:** offer to add batch or start fresh.
5. **Brand book check** for token overrides.
6. **Check for data JSON** (`face-scores.json` etc.) — enables score/cluster filtering.

---

## Phase 2 — Pick Template

Read `${CLAUDE_PLUGIN_ROOT}/references/gallery-templates/README.md` for the full list.

| Need | Template | Key features |
|------|----------|-------------|
| Image comparison with scoring | `pivot-gallery.html` | Pivot matrix, dynamic filters, sort, search, size, lightbox |
| Basic batch comparison | `simple-gallery.html` | Batch tabs, lightbox, search, size |
| Side-by-side with specs | `comparison-gallery.html` | Cards with metadata tables |
| Audio/voice comparison | `audio-gallery.html` | Audio players, engine grouping |

Copy the chosen template to `~/.roxabi/forge/{PROJ}/{SLUG}.html`.

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

### 3. Match pivot seg buttons to DIMS

For each DIMS key, add a `<button class="seg" data-v="KEY">Label</button>` in both the Col and Row segmented controls.

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

Serve:   http://localhost:8080/{PROJ}/{SLUG}.html
Deploy:  cd ~/projects/lyra-stack && make diagrams deploy
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
