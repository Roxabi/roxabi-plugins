# Graph Templates

Reusable HTML templates for static architecture / process-map / hub-and-spoke
diagrams. Consumed by the `forge-chart` skill. Companion to
`gallery-templates/` but for node-edge graphs instead of image grids.

**Lift, don't rebuild.** Before hand-rolling a new SVG, check if one of these
templates covers the case. Copy the right template, fill the `{{PLACEHOLDERS}}`,
tweak coordinates, inline the CSS. Done.

## Showcase

### Radial Hub

> Center pivot + 5 satellites in a square container. 6 bubbles, 5 bidirectional
> labeled arrows. Use for message buses, gateways, hub services, any
> architecture where one component connects N peers.

```
┌───────── Machine 1 · host (dashed frame) ─────────┐
│                                                    │
│               ┌──────────────┐                     │
│               │   node-1     │   (primary / top)   │
│               │  wide amber  │                     │
│               └──────┬───────┘                     │
│                      │  ← inbound.*                │
│                      │    outbound.*               │
│                      ▼                             │
│  ┌────────┐      ╭───────────╮      ┌────────┐    │
│  │ node-2 │─────▶│  hub pill │◀─────│ node-3 │    │
│  │  cyan  │      │   amber   │      │ purple │    │
│  └────────┘      ╰─────┬─────╯      └────────┘    │
│                        │                           │
│                  ╱     │     ╲                     │
│                 ╱      │      ╲                    │
│  ┌────────┐◀─────      │      ─────▶┌────────┐    │
│  │ node-4 │      │     │     │      │ node-5 │    │
│  │ green  │                          │ green  │    │
│  └────────┘                          └────────┘    │
│                                                    │
└────────────────────────────────────────────────────┘
  ↔ bidirectional · pills = priority/port · ⚠ = fragility
```

Reference consumer: `~/.roxabi/forge/lyra/visuals/tabs/nats-roadmap/tab-current.html`
(2.1 Process Map — lyra's NATS hub-and-spoke).

---

## Templates

| Template | When to use | Size | Key features |
|----------|------------|------|--------------|
| `radial-hub.html` | Hub-and-spoke / message bus / gateway with 4–6 peers | ~4K | Center pill hub + 5 satellites, bidirectional labeled arrows, dashed machine frame, pills, fragility warn sub, hover glow |

All templates share **`fgraph-base.css`** — the CSS primitives for graphs.
Distribution model depends on the consumer (see "Inlined vs shared" below).

### Primitives (`fgraph-base.css`)

| Primitive | Purpose |
|-----------|---------|
| `.fgraph-wrap` | Container — square / wide / tall aspect ratio, bordered, padded |
| `.fgraph-wrap.{amber,cyan,purple,green,red}` | Container border tone |
| `.fgraph-frame` + `.fgraph-frame-lbl` + `.fgraph-frame-sub` | Optional inner dashed border (machine / zone / deployment) |
| `.fgraph-edges` | SVG overlay layer (`viewBox="0 0 100 100" preserveAspectRatio="none"`, `pointer-events:none`, `overflow:visible`) |
| `.fg-edge.{tone}` | Colored path (`amber`, `cyan`, `purple`, `green`, `red`, `dim`) — uses `vector-effect: non-scaling-stroke` so strokes stay crisp regardless of container aspect |
| `.mk-{tone}` | Marker (arrowhead) fill classes — apply to `<path>` inside `<marker>` |
| `.fgraph-node` | Absolute-positioned HTML card via `--x` / `--y` / `--w` custom props (all in %) |
| `.fgraph-node.{tone}` | Node border + tint (amber/cyan/purple/green/red) |
| `.fgraph-node.wide` / `.narrow` | Width modifier (30% / 18%, default 22%) |
| `.fgraph-node.pill` | Pill-shaped border-radius 999px — use for the central hub |
| `.fgraph-title.{tone}` | Colored node title with flex for inline pills |
| `.fgraph-pill.{tone}` | Inline badge (priority, port, status) |
| `.fgraph-sub` / `.muted` / `.warn` / `.ok` | Node subtitles (default / muted / red / green) |
| `.fgraph-lbl.{tone}` | Absolute HTML edge label via `--x` / `--y` |
| `.fgraph-legend` | Bottom legend strip |

### Coordinate system

Both nodes and SVG paths use a **0..100 coordinate space**.

| Axis | Nodes | SVG |
|------|-------|-----|
| x | `style="--x:50"` → `50%` from left of container | `d="M 50,..."` |
| y | `style="--y:14"` → `14%` from top | `d="... 14 ..."` |

The SVG layer uses `viewBox="0 0 100 100" preserveAspectRatio="none"` so 1
viewBox unit = 1% of container (width or height). Strokes stay crisp via
`vector-effect: non-scaling-stroke`. Markers may render slightly stretched on
non-square containers — use `.fgraph-wrap.square` for pixel-perfect arrowheads.

---

## Inlined vs shared — when to promote

`fgraph-base.css` has **two distribution modes** depending on the consumer.
Pick based on how the HTML is deployed and how many diagrams reuse the classes.

### Mode A — inlined (default for single-file HTML)

Paste the full content of `fgraph-base.css` into the output's `<style>` block.
The HTML is 100% self-contained — no external files, works with `file://`,
survives any move / rename.

**When to use:**
- `forge-chart` single-file output (`~/.roxabi/forge/<project>/<slug>.html`)
- One-off diagrams
- Anything that must work with `file://` (documentation that gets emailed, dropped into a ticket, etc.)
- Single tab in a multi-tab doc where only one diagram uses fgraph

**Rule:** the forge-chart skill directive "inline, never link" applies here.
This is the default.

### Mode B — shared (for multi-tab docs with ≥ 2 fgraph diagrams)

Deploy `fgraph-base.css` once to `~/.roxabi/forge/_shared/fgraph-base.css`
and reference it from the main shell `<head>` via a relative `<link>`:

```html
<link rel="stylesheet" href="../../_shared/fgraph-base.css">
```

**When to use:**
- Multi-tab roadmap / spec docs where ≥ 2 tabs use fgraph classes
- Any shell where you want one edit to `fgraph-base.css` to propagate across N diagrams
- Matches the existing `gallery-base.{css,js}` precedent

**Setup (one-time):**

```bash
# 1. Copy plugin source → runtime mirror
cp ~/projects/roxabi-plugins/plugins/forge/references/graph-templates/fgraph-base.css \
   ~/.roxabi/forge/_shared/fgraph-base.css

# 2. Add <link> to the shell <head> (path is relative to the .html file)
# For a file at ~/.roxabi/forge/lyra/visuals/my-doc.html:
#   <link rel="stylesheet" href="../../_shared/fgraph-base.css">

# 3. Remove the inline <style>.fgraph-*</style> block from any tab
#    fragments — they now inherit from the shell's linked stylesheet

# 4. Verify deploy — ~/.roxabi/forge/_shared/ must be included when you
#    `make forge deploy`. (It already is, via the gallery-base precedent.)
```

### Promotion checklist

When a second tab adopts fgraph in the same shell:

- [ ] `cp` plugin source → `~/.roxabi/forge/_shared/fgraph-base.css`
- [ ] Add `<link>` to the shell `<head>` (after Google Fonts, before design-tokens `<style>`)
- [ ] Delete every inline `<style>.fgraph-*</style>` block from tab fragments
- [ ] Verify all tabs still render (reload each one)
- [ ] When editing `fgraph-base.css`, remember: both the plugin source AND the `_shared/` mirror must stay in sync. Treat the `_shared/` copy as a deploy artifact, not an independent file.

### Precedent

This is the same pattern galleries already use:

```
~/projects/roxabi-plugins/plugins/forge/references/gallery-templates/
  gallery-base.css       ← plugin source of truth
  gallery-base.js
  pivot-gallery.html     ← template references ../../_shared/gallery-base.css

~/.roxabi/forge/_shared/
  gallery-base.css       ← runtime mirror, deployed alongside galleries
  gallery-base.js
  fgraph-base.css        ← runtime mirror, deployed alongside fgraph diagrams
```

---

## How to customise `radial-hub.html`

### Step 1 — Fill placeholders

| Placeholder | Example | Where |
|-------------|---------|-------|
| `{{TITLE}}` | `Lyra — NATS Architecture Roadmap` | `<title>`, diagram-meta |
| `{{TITLE_PLAIN}}` / `{{TITLE_ACCENT}}` | `Current` / `Topology` | `<h1>` split for accent color |
| `{{DATE}}` | `2026-04-09` | diagram-meta |
| `{{CATEGORY}}` / `{{CAT_LABEL}}` / `{{COLOR}}` | `plan` / `Plan` / `amber` | diagram-meta |
| `{{CATEGORY_LABEL}}` | `CURRENT STATE` | header eyebrow |
| `{{SUBTITLE}}` | `Production state — verified @ staging` | header subtitle |
| `{{DIAGRAM_ARIA_LABEL}}` | `Lyra production process map` | `<div role="img">` aria-label |
| `{{FRAME_LABEL}}` | `Machine 1 · roxabituwer` | Dashed frame top-left caption |
| `{{FRAME_SUB}}` | `supervisord · lyra.service` | Dashed frame sub-caption |

### Step 2 — Node placeholders

Six nodes — one hub (pill, center) and five satellites (`node-1` through
`node-5`).

| Placeholder | Example |
|-------------|---------|
| `{{NODE_1_NAME}}` / `{{NODE_1_PILL}}` / `{{NODE_1_SUB}}` / `{{NODE_1_WARN}}` | `lyra_hub` / `p=100` / `PoolManager · Middleware` / `⚠ CliPool [C1]` |
| `{{NODE_2_NAME}}` / `{{NODE_2_PILL}}` / `{{NODE_2_SUB}}` / `{{NODE_2_SUB_MUTED}}` | `lyra_telegram` / `p=200` / `aiogram long-polling` / `adapter_standalone.py` |
| `{{NODE_3_NAME}}` / `{{NODE_3_PILL}}` / `{{NODE_3_SUB}}` / `{{NODE_3_SUB_MUTED}}` | `lyra_discord` / `p=200` / `discord.py websocket` / `adapter_standalone.py` |
| `{{HUB_NAME}}` / `{{HUB_SUB}}` / `{{HUB_SUB_MUTED}}` | `nats.container` / `Quadlet · single node` / `:4223 → :4222` |
| `{{NODE_4_NAME}}` / `{{NODE_4_PILL}}` / `{{NODE_4_SUB}}` / `{{NODE_4_SUB_MUTED}}` | `voicecli_tts` / `worker` / `NatsAdapterBase` / `Qwen3 · Chatterbox` |
| `{{NODE_5_NAME}}` / `{{NODE_5_PILL}}` / `{{NODE_5_SUB}}` / `{{NODE_5_SUB_MUTED}}` | `voicecli_stt` / `worker` / `NatsAdapterBase` / `Whisper` |

**Tone defaults:**
- node-1 (top): `amber wide` — primary process, bigger card
- node-2 (mid-left): `cyan`
- node-3 (mid-right): `purple`
- hub (center): `amber pill` — the bus / broker
- node-4 (bot-left): `green`
- node-5 (bot-right): `green`

Change the tone classes on the `<div class="fgraph-node …">` elements to match
your domain. Any of `amber`, `cyan`, `purple`, `green`, `red`.

### Step 3 — Edge labels

Each edge has an HTML label positioned via `--x` / `--y` in %.

| Placeholder | Default position | Example |
|-------------|------------------|---------|
| `{{EDGE_1_LABEL}}` / `{{EDGE_1_LABEL_B}}` / `{{EDGE_1_HINT}}` | `--x:50;--y:36` | `lyra.inbound.*` / `lyra.outbound.*` / `HUB_INBOUND` (dim) |
| `{{EDGE_2_LABEL}}` | `--x:30;--y:51` | `telegram.<bot_id>` |
| `{{EDGE_3_LABEL}}` | `--x:70;--y:51` | `discord.<bot_id>` |
| `{{EDGE_4_LABEL}}` | `--x:30;--y:68` | `tts.req/res` |
| `{{EDGE_5_LABEL}}` | `--x:70;--y:68` | `stt.req/res` |

Labels use `<br/>` for multi-line. Wrap dim hints in `<span class="dim">...</span>`.

### Step 4 — Tweak coordinates (optional)

The defaults place nodes on a symmetric radial layout:

| Node | x | y |
|------|---|---|
| node-1 (top) | 50 | 14 |
| node-2 (mid-left) | 13 | 34 |
| node-3 (mid-right) | 87 | 34 |
| hub (center) | 50 | 58 |
| node-4 (bot-left) | 13 | 80 |
| node-5 (bot-right) | 87 | 80 |

**If you move a node**, update the corresponding arrow path's endpoints too.
Arrow endpoints sit roughly at the node's visible edge, not its center (so the
arrowhead isn't covered by the card). For the default layout:

| Edge | Path |
|------|------|
| node-1 ↔ hub (vertical) | `M 50,22 L 50,50` |
| node-2 ↔ hub (curve) | `M 25,38 Q 33,48 42,55` |
| node-3 ↔ hub (curve) | `M 75,38 Q 67,48 58,55` |
| node-4 ↔ hub (curve) | `M 25,75 Q 32,68 42,62` |
| node-5 ↔ hub (curve) | `M 75,75 Q 68,68 58,62` |

### Step 5 — Inline fgraph-base.css

Replace the `{{FGRAPH_BASE}}` placeholder in the template's `<style>` block
with the content of `fgraph-base.css`. Forge directive: inline, never link.

---

## When NOT to use radial-hub

| If your diagram is… | Use instead |
|--------------------|-------------|
| Linear flow / pipeline | `flowchart LR` via Mermaid (see `mermaid-guide.md`) — dagre auto-layout wins |
| Sequence / message exchange | `sequenceDiagram` via Mermaid |
| State machine | `stateDiagram-v2` via Mermaid |
| Dependency graph > 8 nodes | Mermaid `flowchart TD` — dagre handles N peers, fgraph caps at ~6 satellites before labels collide |
| Tree / hierarchy | Mermaid `flowchart TD` with `subgraph` |
| Rich cards stacked vertically (no hub) | `architecture.html` pattern from visual-explainer — CSS Grid cards + tiny inline SVG connectors |

`fgraph` is optimized for the specific case where **one center node connects
N peers** and the peers deserve **rich HTML card content** (pills, pill shapes,
warn lines, wrapped text). For anything else, Mermaid is almost always lower
effort.

---

## Decision matrix: fgraph vs Mermaid vs pure SVG

| Criterion | `fgraph` (HTML cards + SVG overlay) | Mermaid | Pure inline SVG |
|-----------|-------------------------------------|---------|-----------------|
| Radial / hub-and-spoke layout | ✅ natural | ❌ dagre flattens to linear | ✅ but tedious |
| Rich card content (pills, warn, wrap) | ✅ native HTML | ⚠ `<br>` only, no CSS flex | ❌ no text wrap |
| Auto-layout for N > 8 nodes | ❌ manual | ✅ dagre / ELK | ❌ manual |
| Labels on edges | ✅ HTML `<div>` | ✅ native syntax | ⚠ `<text>` + positioning |
| Pixel-perfect control | ✅ | ❌ | ✅ |
| One-shot authoring cost (new diagram) | low (fill placeholders) | low (write graph LR …) | high (recompute all coords) |
| Runtime dependencies | none | Mermaid 11 ESM from CDN | none |
| Dark/light theme | ✅ CSS vars | ⚠ re-render needed | ✅ CSS vars |
| Hover / interactivity | ✅ CSS | ⚠ needs bindFunctions | ⚠ SVG filter |
| Works in fetched tab fragment (`innerHTML`) | ✅ | ⚠ `mermaid.run()` after inject | ✅ |
| Accessibility | ✅ real HTML | ✅ Mermaid emits SVG + titles | ⚠ `role="img"` + aria-label only |

**Rule of thumb:**
- 6 nodes, radial, rich cards → **fgraph**
- 8+ nodes, linear/topology → **Mermaid**
- Fallback when neither fits → **pure SVG** (last resort)

---

## Authoring checklist

- [ ] Copied `radial-hub.html` to the output path
- [ ] Inlined `fgraph-base.css` into `{{FGRAPH_BASE}}` placeholder
- [ ] Filled all `{{TITLE}}`, `{{DATE}}`, `{{CATEGORY}}`, `{{COLOR}}` diagram-meta
- [ ] Filled all 6 node placeholders (`NODE_1_*` through `NODE_5_*` + `HUB_*`)
- [ ] Filled all 5 edge labels (`EDGE_1_*` through `EDGE_5_LABEL`)
- [ ] Verified tone classes match the domain (amber = hub, cyan = X, …)
- [ ] If a node moved: arrow path endpoints updated to match
- [ ] Container uses `square` aspect unless you tested `wide`/`tall` coordinates
- [ ] All labels fit within their assigned region (no overlap with nodes or other labels)
- [ ] Tested hover glow works (card lifts + box-shadow)
- [ ] Tested dark + light theme toggle (if shell includes one)

---

## Future templates (not yet written)

| Template | Shape |
|----------|-------|
| `radial-ring.html` | N satellites in a true ring (no center hub) — inter-peer edges |
| `layered.html` | 3–4 horizontal layers (ingress → hub → workers → storage) with rich cards |
| `machine-clusters.html` | Multiple dashed machine frames side-by-side with cross-machine edges |
| `deployment-tiers.html` | Dev / staging / prod stacked with data-flow arrows |

Contributions welcome — mirror the `radial-hub.html` + README pattern.
</content>
</invoke>