# diagrams

Generate HTML diagrams, visuals, and galleries for the `~/.roxabi/forge/` ecosystem — brand-aware, manifest-indexed, Cloudflare Pages ready.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install forge
```

## Skills

| Skill | Trigger | What it creates |
|-------|---------|-----------------|
| `init` | "init forge", "setup forge", "forge init" | Set up `~/.roxabi/forge/` with server, shared assets, directory structure |
| `guide` | "guide", "user guide", "project recap", "architecture doc", "analysis", "comparison", "roadmap" | Split-file multi-tab doc: shell HTML + CSS + JS + tab fragments |
| `epic` | "epic", "epic preview", "issue visual", "issue plan", "#N" | Issue/epic-linked analysis tied to a GitHub issue number |
| `chart` | "chart", "flowchart", "dependency tree", "mermaid", "quick chart" | Self-contained single-file Mermaid or CSS visual |
| `gallery` | "gallery", "image gallery", "brand gallery", "audio gallery" | Image or audio comparison gallery (requires `forge-init` first) |

## When to use each

**`guide`** — any rich multi-section document: user guide, architecture overview, project recap, analysis/comparison, roadmap. Split-file, lazy-loaded tabs. Like `lyra-user-guide-v16`.

**`epic`** — always tied to a GitHub issue `#N`. Produces: overview, scope breakdown, dependency graph, acceptance criteria. Filename always includes the issue number (e.g. `477-tool-registry.html`). Like `tool-registry-477`.

**`chart`** — quick single diagram: Mermaid flowchart, dependency tree, sequence diagram, simple CSS layout. Self-contained, works with `file://`. Like `445-nats-dependency-tree`.

**`gallery`** — comparing brand iterations, avatar batches, TTS engine outputs, voice clones. Uses HTML templates with dynamic filtering, sorting, search, and pivot grouping.

### Gallery templates (v0.4.0)

5 ready-to-use templates in `references/gallery-templates/`:

<table>
<tr>
<td width="50%">

**Pivot Gallery** — `pivot-gallery.html`

Matrix view with col×row grouping. Dynamic filters, score-based sorting, search, size +/−. Best for: image comparison with scoring/clustering data.

*Example: V20 avatar A/B test — 400 images, batch × score matrix*

</td>
<td width="50%">

**Simple Gallery** — `simple-gallery.html`

Batch tabs with starring. Tag-based filtering, lightbox with prev/next. Best for: iterative exploration (V1 → V2 → V3 batches).

*Example: Avatar gallery — 38 exploration + 36 refinement images*

</td>
</tr>
<tr>
<td>

**Comparison Gallery** — `comparison-gallery.html`

Cards with spec tables and verdict badges. Best for: pipeline comparison with detailed metadata per image.

*Example: 1024 pipeline comparison — Klein 4B vs FLUX.1-dev vs PuLID variants*

</td>
<td>

**Audio Gallery** — `audio-gallery.html`

Audio players with engine/quality badges. Card and list views. Best for: TTS engine comparison, voice cloning A/B tests.

*Example: VoiceCLI engine compare — 5 engines × 10 samples*

</td>
</tr>
<tr>
<td colspan="2">

**Multi-Mode Gallery** — `multi-mode-gallery.html` *(new in v0.4.0)*

Mode tab bar with per-mode DIMS, atomic mode switching, downloads dropdown, pixel-art rendering. Best for: multi-dataset visualizations where each mode has its own dimensions (sprite browsers, A/B/C dataset comparisons, mode-based tabs).

Uses the items-as-objects pattern: each mode's `buildItems()` returns `{file, dir, label, ...customFields}` and `dim.fn` reads fields directly. Includes a 5-step incremental upgrade path documented in `references/gallery-templates/README.md` for migrating existing single-mode galleries.

*Example: PI Buddy sprite gallery — 3 modes (Baby Showcase 512×512, Full Set 256×256, Production 32×32 sprites) × 24 species*

</td>
</tr>
</table>

All templates share `gallery-base.css` (tokens, toolbar, controls, `.pixelated` utility, downloads dropdown `.dl-*`, toast `.toast-*`) + `gallery-base.js` (theme, dual-API filter builder, segmented controls, file discovery, batch bar, starring, `initDownloads` dropdown, `buildPivotSegsFromDims` dynamic pivot, `showToast` with a11y). Dynamic filters (OFF = inactive = show all), search, sort, size controls, lightbox, manifest.json discovery.

See `references/gallery-templates/README.md` for customisation guide, including the "Items-as-objects vs filename-strings" pattern, downloads dropdown + CSP requirements, dynamic pivot seg construction, pixel-art rendering, and the incremental single-mode → multi-mode upgrade path.

## How it works

### Brand-aware

Checks `~/.roxabi/forge/<project>/brand/BRAND-BOOK.md` and `~/projects/<project>/brand/BRAND-BOOK.md` before choosing a palette. Fallback: Lyra → Forge Orange, Roxabi/2ndBrain → Gold.

### Manifest-indexed

Every HTML file includes `diagram:*` meta tags parsed by `serve.py` and `gen-manifest.py` into `manifest.json` — which powers the gallery UI at `http://localhost:8080/`.

### Cloudflare Pages

```bash
make forge deploy       # from the supervisor hub directory
```

### BATCHES pattern (galleries)

Single `BATCHES` array = source of truth. Adding a new batch = one line. Everything else derives automatically.

### Dynamic filters (galleries)

All filter buttons start **OFF** — filter is inactive, all images shown. Clicking a button activates that filter dimension. Values are auto-discovered from data at load time — no hardcoded button lists.

## Output paths

| Context | Path |
|---------|------|
| Guide / epic / chart (exploration) | `~/.roxabi/forge/<project>/visuals/` |
| Guide (final / canonical) | `~/projects/<project>/docs/visuals/` |
| Gallery | `~/.roxabi/forge/<project>/` |
| Cross-project chart | `~/.roxabi/forge/_shared/diagrams/` |

## Serving

```bash
# Full gallery — diagrams supervisord on :8080
http://localhost:8080/

# Standalone (split-file guide or epic)
cd ~/.roxabi/forge/<project>/visuals && python3 -m http.server 8080

# Chart — no server needed
file://~/.roxabi/forge/<project>/visuals/<name>.html
```
