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

### Linear Flow

> 3 stages in a horizontal pipe — source → middle → sink. Unidirectional
> arrows with labels above. Use for data flows, request/response paths,
> inbound/outbound pipelines, any left-to-right narrative.

```
┌──────────────────────────────────────────────────────────────┐
│                                                               │
│       publish subject           subscribe queue               │
│       ─────────────             ────────────────              │
│                                                               │
│  ┌────────┐    ───▶    ╭────────╮    ───▶    ┌──────────┐   │
│  │ source │            │  bus   │             │   sink   │   │
│  │  cyan  │            │ amber  │             │  amber   │   │
│  │        │            │  pill  │             │   wide   │   │
│  └────────┘            ╰────────╯             └──────────┘   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
  one-way arrows · labels above · 16/6 aspect · middle can be pill or wide
```

Reference consumers:
- `tab-current.html` 2.3 Inbound Flow (adapter → NATS → hub)
- `tab-current.html` 2.4 Outbound Streaming (middle card holds 4-step publish sequence)

### Dual Cluster

> 2 peers at the top sharing 2 central resources. Wide-bulge arrow routing
> avoids center-crossing. Use for HA pairs, dual-replica workers, any
> cluster where 2 components share a session store + a message bus.

```
┌────── Machine 1 · dual hub cluster ──────┐
│                                            │
│  ┌────────┐              ┌────────┐       │
│  │ peer-1 │              │ peer-2 │       │
│  │ purple │              │ purple │       │
│  └─┬────┬─┘              └─┬────┬─┘       │
│    │    ╲                  ╱    │          │
│    │     ╲  SET/GET · ..  ╱     │          │
│    │      ╲───╭──────╮───╱      │          │
│    │          │res-a │          │          │
│    │          │ pill │          │          │
│    │          ╰──────╯          │          │
│    │                             │          │
│    ╲       HUB_INBOUND           ╱          │
│     ╲───────╭──────╮────────────╱           │
│             │res-b │                        │
│             │ pill │                        │
│             ╰──────╯                        │
└────────────────────────────────────────────┘
  4 bidirectional edges · bulge-routed · single centered labels
```

Reference consumer: `tab-target.html` M3 (dual-hub lyra_hub-1 + lyra_hub-2 sharing Redis + NATS).

### Radial Ring

> N satellites in a true ring (no center hub). Inter-peer edges connect
> neighbors around the circle. Use for peer-to-peer meshes, ring buffers,
> consensus rings (Raft participants), any topology where nodes talk to
> their neighbors.

```
        node-1 (top)
       ╱          ╲
  node-6            node-2
   │                  │
   │     ring ring    │
   │                  │
  node-5            node-3
       ╲          ╱
        node-4 (bottom)
```

Reference consumer: (future) consensus-visualizer for distributed systems.

### Layered

> 4 horizontal layers stacked vertically — ingress → hub → workers → storage.
> Each layer has a dashed frame + label. Use for classic 3-tier / 4-tier
> architectures, request processing pipelines, clean architecture layers.

```
┌──────────── Ingress ────────────┐
│  ┌──────────────────────────┐   │
│  │      gateway / API       │   │
│  └──────────────────────────┘   │
└──────────────────────────────────┘
                │
                ▼
┌──────────── Router ────────────┐
│  ╭────────────────────────────╮ │
│  │      message bus pill      │ │
│  ╰────────────────────────────╯ │
└──────────────────────────────────┘
           ╱     ╲
          ▼       ▼
┌────── Workers ───────┐
│  ┌────┐    ┌────┐     │
│  │w-1 │    │w-2 │     │
│  └────┘    └────┘     │
└───────────────────────┘
           ╲     ╱
            ▼   ▼
┌──────── Storage ───────────────┐
│  ┌──────────────────────────┐  │
│  │    database / cache      │  │
│  └──────────────────────────┘  │
└────────────────────────────────┘
```

Reference consumer: (future) service-architecture explainer.

### Machine Clusters

> 3 machine frames side-by-side with cross-machine edges. Each frame has its
> own dashed border + label. Use for multi-host deployments, dev/staging/prod
> side-by-side, microservices distributed across machines.

```
┌────── Machine-1 ──────┐  ┌────── Machine-2 ──────┐  ┌────── Machine-3 ──────┐
│  ┌────┐               │  │  ┌────┐               │  │               ┌────┐ │
│  │hub │               │  │  │hub │               │  │               │ext │ │
│  └────┘               │  │  └────┘               │  │               └────┘ │
│    │                  │  │    │                  │  │                  │    │
│  ┌────┐               │  │  ┌────┐               │  │                  │    │
│  │adapter│            │  │  │shared│             │  │                  │    │
│  └────┘               │  │  └────┘               │  │                  │    │
└───────────────────────┘  └───────────────────────┘  └───────────────────────┘
         │                            │                           │
         └────────────────────────────┴───────────────────────────┘
                    cross-machine edges (bulge routing)
```

Reference consumer: (future) distributed-deployment map.

### Deployment Tiers

> 3 deployment tiers stacked vertically — dev / staging / prod. Each tier
> has a colored stripe + label. Promotion arrows flow upward (dev → staging → prod).
> Data sync arrows flow between tiers. Use for CI/CD pipeline visualization.

```
┌────────────────── Production (green) ──────────────────┐
│  ┌──────────┐        ┌─────────┐                       │
│  │ service  │◀──────▶│   db    │   ← data sync        │
│  └──────────┘        └─────────┘                       │
│         ▲                                              │
│         │ promote                                      │
├────────────────── Staging (cyan) ─────────────────────┤
│  ┌──────────┐        ┌─────────┐                       │
│  │ service  │◀──────▶│   db    │                       │
│  └──────────┘        └─────────┘                       │
│         ▲                                              │
│         │ promote                                      │
├────────────────── Dev (amber) ────────────────────────┤
│  ┌─────────────────────────┐                          │
│  │    local dev env        │                          │
│  └─────────────────────────┘                          │
└───────────────────────────────────────────────────────┘
```

Reference consumer: (future) deployment-flow explainer.

---

## Templates

| Template | When to use | Size | Key features |
|----------|------------|------|--------------|
| `radial-hub.html` | Hub-and-spoke / message bus / gateway with 4–6 peers | ~4K | Center pill hub + 5 satellites, bidirectional labeled arrows, dashed machine frame, pills, fragility warn sub, hover glow |
| `linear-flow.html` | 3-stage pipeline (source → middle → sink) | ~3K | 3 horizontal cards, single-direction arrows, labels above, 16/6 aspect, middle pill or wide, any-tone edges |
| `dual-cluster.html` | 2 peers sharing 2 central resources (HA pair + session + bus) | ~4K | 2 top peers + center resource + bottom bus, 4 bidirectional arrows with wide-bulge routing, single centered labels, square aspect |
| `radial-ring.html` | Peer-to-peer mesh / ring buffer / consensus ring (no center hub) | ~4K | 6 nodes in a circle, clockwise inter-peer edges, labels outside ring, square aspect |
| `layered.html` | 3–4 horizontal layers (ingress → hub → workers → storage) | ~5K | 4 stacked layers with dashed frames, vertical fan-out/fan-in arrows, tall aspect (3/4), optional 3-layer variant |
| `machine-clusters.html` | Multi-host deployment / distributed services across machines | ~5K | 3 machine frames side-by-side, cross-machine edge routing, wide aspect (16/9), per-machine labels |
| `deployment-tiers.html` | CI/CD pipeline / dev → staging → prod promotion | ~5K | 3 colored tier stripes, promotion arrows upward, data sync arrows, tall aspect (4/5), tier-specific tones |

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
| `.fgraph-node.pill` | Pill-shaped — use for the central hub / bus / broker |
| `.fgraph-node.circle` | Circle — event, trigger, start/end (`border-radius: 50%; aspect-ratio: 1`) |
| `.fgraph-node.hexagon` | Hexagon — agent, worker, autonomous unit (`clip-path` polygon) |
| `.fgraph-node.diamond` | Diamond — decision, gate, conditional (`clip-path` polygon) |
| `.fgraph-node.cylinder` | Cylinder — database, storage, queue (ellipse caps via `::before`/`::after`) |
| `.fgraph-node.folded` | Folded corner — file, config, document (`clip-path` with corner notch) |
| `.fg-edge.dashed` | Dashed stroke — optional / async / planned path |
| `.fg-edge.thick` | Thick stroke (2.8px) — primary data flow / critical path |
| `.fg-edge.animated` | Animated dashes — live stream / active connection |
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

### Shape vocabulary

Shapes are semantic — pick by **what the node is**, not how you want it to look.
Full reference: [`../shape-vocabulary.md`](../shape-vocabulary.md).

| Shape | Class | Use when node is... |
|-------|-------|---------------------|
| Rounded rect | *(default)* | A service, process, or generic component |
| Pill | `.pill` | A bus, broker, router, or relay |
| Circle | `.circle` | An event, trigger, signal, or lifecycle point |
| Hexagon | `.hexagon` | An agent, worker, or autonomous unit |
| Diamond | `.diamond` | A decision, gate, or conditional branch |
| Cylinder | `.cylinder` | A database, cache, queue, or data store |
| Folded | `.folded` | A file, config, document, or static asset |

Arrow modifiers compose with tones on `.fg-edge`:

| Modifier | Class | Use when path is... |
|----------|-------|---------------------|
| Dashed | `.dashed` | Optional, async, planned, or fallback |
| Thick | `.thick` | Critical path or primary data flow |
| Animated | `.animated` | Live stream or real-time connection |

Shapes compose with tones and sizes: `<div class="fgraph-node hexagon amber wide">`.
Arrow modifiers stack: `<path class="fg-edge cyan thick animated">`.

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

## Shape picker — which template?

Pick by layout intent, not by domain. Any template can be re-tinted
(tones, pills) to match the domain.

| Your diagram shape | Template | Reference |
|--------------------|----------|-----------|
| 1 center + 4–6 peers radiating out | `radial-hub.html` | 2.1, M1, M2 |
| 3 stages in a horizontal pipe (source → middle → sink) | `linear-flow.html` | 2.3, 2.4 |
| 2 peers + 2 shared resources (HA pair cluster) | `dual-cluster.html` | M3 |
| N nodes in a ring, each talks to neighbors | `radial-ring.html` | consensus visualizer |
| 3–4 horizontal layers stacked vertically | `layered.html` | service architecture |
| 2–3 machine frames side-by-side | `machine-clusters.html` | distributed deployment |
| Dev / staging / prod tiers stacked | `deployment-tiers.html` | CI/CD pipeline |
| Something that doesn't fit | start from the closest template, reposition nodes via `--x`/`--y`, repaint arrow paths to match |

All three templates share the same `fgraph-base.css` primitives.
Differences live only in layout coordinates, not in CSS — so mixing
features (e.g. a linear-flow with a dashed machine frame borrowed from
radial-hub) is just copy-paste.

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
Arrow endpoints sit at the node's visible **edge**, not its center (so the
arrowhead isn't covered by the card).

### Edge endpoint calculation

For a node at `--y:Y` with height `--h:H` (default 22%, wide=30%, narrow=18%):

```
node_top_edge    = Y - (H / 2)
node_bottom_edge = Y + (H / 2)
node_left_edge   = X - (W / 2)
node_right_edge  = X + (W / 2)
```

**Example:** Node at `--x:50;--y:14` with `--w:30%` (wide):
- Height ≈ 16% of container (card padding + content)
- Top edge ≈ y=14 - 8 = **6** (but card extends, so visible top is ~y=10)
- Bottom edge ≈ y=14 + 8 = **22** (arrow starts here)
- Left edge ≈ x=50 - 15 = **35**
- Right edge ≈ x=50 + 15 = **65**

For the hub pill at `--y:58`:
- Top edge ≈ **50** (arrow from node-1 ends here)
- Bottom edge ≈ **66**

**Rule of thumb:** Add ~8 units padding from the edge to prevent arrowheads
from touching the card border. For curves, the control point should bulge
away from the center to route around intervening nodes.

For the default layout:

| Edge | Path | Calculation |
|------|------|-------------|
| node-1 ↔ hub (vertical) | `M 50,22 L 50,50` | node-1 bottom (14+8=22) → hub top (58-8=50) |
| node-2 ↔ hub (curve) | `M 25,38 Q 33,48 42,55` | node-2 bottom-right (13+12=25, 34+4=38) → hub top-left |
| node-3 ↔ hub (curve) | `M 75,38 Q 67,48 58,55` | node-3 bottom-left (87-12=75, 34+4=38) → hub top-right |
| node-4 ↔ hub (curve) | `M 25,75 Q 32,68 42,62` | node-4 top-right (13+12=25, 80-5=75) → hub bottom-left |
| node-5 ↔ hub (curve) | `M 75,75 Q 68,68 58,62` | node-5 top-left (87-12=75, 80-5=75) → hub bottom-right |

### Step 5 — Inline fgraph-base.css

Replace the `{{FGRAPH_BASE}}` placeholder in the template's `<style>` block
with the content of `fgraph-base.css`. Forge directive: inline, never link.

---

## How to customise `linear-flow.html`

3 nodes on a horizontal line. Much simpler than radial-hub — fewer
placeholders, fewer coordinate knobs.

### Step 1 — Placeholders

| Placeholder | Example | Notes |
|-------------|---------|-------|
| `{{TITLE}}` / `{{DATE}}` / `{{CATEGORY}}` / etc. | standard diagram-meta | same as radial-hub |
| `{{WRAP_TONE}}` | `green` / `amber` / `cyan` | container border color |
| `{{SOURCE_NAME}}` / `{{SOURCE_SUB}}` / `{{SOURCE_SUB_MUTED}}` | `lyra_telegram` / `aiogram handler` / `NatsBus.put` | left card |
| `{{SOURCE_TONE}}` | `cyan` | left card tone |
| `{{MIDDLE_NAME}}` / `{{MIDDLE_SUB}}` / `{{MIDDLE_SUB_MUTED}}` | `nats.container` / `single-node broker` / `` | center card |
| `{{MIDDLE_TONE}}` | `amber` | center card tone |
| `{{SINK_NAME}}` / `{{SINK_SUB_1}}` / `{{SINK_SUB_2}}` / `{{SINK_SUB_MUTED}}` | `lyra_hub` / `staging.put_nowait` / `hub.run → middleware` / `→ Pool._inbox` | right card (wide by default, fits 4 lines) |
| `{{SINK_TONE}}` | `amber` | right card tone |
| `{{EDGE_1_TONE}}` / `{{EDGE_2_TONE}}` | `cyan` / `amber` | arrow + label colors |
| `{{EDGE_1_LABEL}}` / `{{EDGE_1_HINT}}` | `publish` / `lyra.inbound.telegram.<bot>` | label above first arrow, 2 lines |
| `{{EDGE_2_LABEL}}` / `{{EDGE_2_HINT}}` | `subscribe` / `HUB_INBOUND queue group` | label above second arrow |
| `{{LEGEND}}` | `one-way publish · all (platform, bot_id) pairs fan into single staging queue` | bottom strip |

### Step 2 — Middle card shape

Default is `pill` (for buses, brokers, routers). For an action node
that holds a numbered sequence of steps (like 2.4 Outbound with 4
publish steps), swap `pill` → `wide`:

```html
<!-- bus / broker -->
<div class="fgraph-node amber pill" style="--x:50;--y:55;">
  <div class="fgraph-title amber">nats.container</div>
  ...

<!-- action node with 4 numbered substeps -->
<div class="fgraph-node amber wide" style="--x:50;--y:55;">
  <div class="fgraph-title amber">NatsChannelProxy.send_streaming</div>
  <div class="fgraph-sub">1. publish stream_start</div>
  <div class="fgraph-sub">2. publish chunks</div>
  <div class="fgraph-sub">3. publish stream_end</div>
  <div class="fgraph-sub warn">4. on exception → stream_error</div>
</div>
```

When using `wide`, bump aspect-ratio from `16/6` → `16/7` so the taller
middle card doesn't push labels off-screen.

### Step 3 — Bidirectional arrows (optional)

Default is single-direction (marker-end only). For request/reply:

```html
<path class="fg-edge cyan" d="M 25,55 L 39,55"
      marker-start="url(#fg-arr-cyan-lf)"
      marker-end="url(#fg-arr-cyan-lf)"/>
```

### Step 4 — Coordinates (rarely need to touch)

Defaults assume 3 default-width cards at x = 14 / 50 / 85. If the middle
is `wide` (30% width vs 22%), it extends further left/right; nudge the
arrow endpoints from `39,55 → 35,55` and `61,55 → 65,55`.

---

## How to customise `dual-cluster.html`

2 peers sharing 2 central resources. Use for HA pairs, dual-replica
workers, any cluster with 2 shared dependencies.

### Step 1 — Placeholders

| Placeholder | Example | Notes |
|-------------|---------|-------|
| `{{TITLE}}` / `{{DATE}}` / etc. | standard diagram-meta | |
| `{{WRAP_TONE}}` | `purple` | container border color |
| `{{FRAME_LABEL}}` / `{{FRAME_SUB}}` | `Machine 1 · dual hub cluster` / `stateless routers + shared state` | dashed frame caption |
| `{{PEER_TONE}}` | `purple` | both peers share the same tone |
| `{{PEER_1_NAME}}` / `{{PEER_1_PILL}}` / `{{PEER_1_SUB}}` / `{{PEER_1_SUB_MUTED}}` | `lyra_hub-1` / `p=100` / `stateless router` / `no Pool in-memory` | top-left peer |
| `{{PEER_2_NAME}}` / `{{PEER_2_PILL}}` / `{{PEER_2_SUB}}` / `{{PEER_2_SUB_MUTED}}` | `lyra_hub-2` / `p=100` / ... | top-right peer (symmetric) |
| `{{RESOURCE_A_TONE}}` | `purple` | center resource tone |
| `{{RESOURCE_A_NAME}}` / `{{RESOURCE_A_SUB}}` / `{{RESOURCE_A_SUB_MUTED}}` | `Redis` / `AOF persistence` / `lyra:session:*` | center resource (pill by default) |
| `{{RESOURCE_A_LABEL}}` / `{{RESOURCE_A_HINT}}` | `SET / GET` / `lyra:session:<pool_id>` | single centered label above resource-a |
| `{{RESOURCE_B_TONE}}` | `amber` | bottom bus tone |
| `{{RESOURCE_B_NAME}}` / `{{RESOURCE_B_SUB}}` | `nats.container` / `shared HUB_INBOUND` | bottom bus (pill by default) |
| `{{RESOURCE_B_LABEL}}` / `{{RESOURCE_B_HINT}}` | `HUB_INBOUND` / `shared queue group` | single centered label above resource-b |
| `{{LEGEND}}` | `any user → either hub · state in Redis · adapters unchanged` | bottom strip |

### Step 2 — When you only have 1 shared resource

Strip the bottom half: remove the `{{RESOURCE_B_*}}` node, the 2 bus
arrows (lines with `d="M 15,21 Q 15,55 42,81"` and its symmetric pair),
and the `{{RESOURCE_B_LABEL}}` line. Change container aspect to `16/10`
(wide) — the cluster + 1 resource doesn't need square.

### Step 3 — When you have different tones per peer

Swap `{{PEER_TONE}}` for explicit per-peer tones by duplicating the node
block with different classes. You'll lose the symmetric look but it's
useful for primary/standby patterns (e.g. amber + green).

### Step 4 — Coordinates (if peers move)

Default peer positions are `(20, 16)` and `(80, 16)`. If you move them
further apart or closer, update arrow endpoints:

| Arrow | Current | Rule of thumb |
|-------|---------|---------------|
| peer-1 ↔ resource-a | `M 25,21 Q 32,36 44,50` | start at peer-1 bottom-right, end at resource-a top-left |
| peer-2 ↔ resource-a | `M 75,21 Q 68,36 56,50` | symmetric |
| peer-1 ↔ resource-b | `M 15,21 Q 15,55 42,81` | start at peer-1 bottom-left, bulge far-left to route around resource-a, end at resource-b top-left |
| peer-2 ↔ resource-b | `M 85,21 Q 85,55 58,81` | symmetric, bulge far-right |

The bulge control points at `x=15` / `x=85` are what route the long
arrows around resource-a. Don't lower them toward the center or they'll
cross through the resource card.

---

## How to customise `radial-ring.html`

6 nodes arranged in a circle, each connected to its neighbors. No center
hub — the topology is a true ring. Use for peer-to-peer meshes, ring
buffers, consensus rings.

### Step 1 — Placeholders

| Placeholder | Example | Notes |
|-------------|---------|-------|
| `{{TITLE}}` / `{{DATE}}` / etc. | standard diagram-meta | |
| `{{WRAP_TONE}}` | `amber` | container border color |
| `{{NODE_1_NAME}}` / `{{NODE_1_PILL}}` / `{{NODE_1_SUB}}` / `{{NODE_1_SUB_MUTED}}` | `node-alpha` / `leader` / `consensus participant` / `port:8001` | top node |
| `{{NODE_2_NAME}}` ... `{{NODE_6_NAME}}` | ... | clockwise around the ring |
| `{{NODE_1_TONE}}` ... `{{NODE_6_TONE}}` | `amber` / `cyan` / `purple` / `green` / `amber` / `cyan` | per-node border color |
| `{{EDGE_1_TONE}}` ... `{{EDGE_6_TONE}}` | `cyan` | edge colors (can match node tones) |
| `{{EDGE_1_LABEL}}` ... `{{EDGE_6_LABEL}}` | `gossip` / `replicate` / `vote` | labels outside ring near each edge |
| `{{LEGEND}}` | `clockwise message flow · each node talks to neighbors` | bottom strip |

### Step 2 — Ring coordinates

Nodes are positioned at ~35% radius from center:

| Node | x | y | Position |
|------|---|---|----------|
| node-1 | 50 | 15 | top |
| node-2 | 80 | 30 | top-right |
| node-3 | 80 | 70 | bot-right |
| node-4 | 50 | 85 | bottom |
| node-5 | 20 | 70 | bot-left |
| node-6 | 20 | 30 | top-left |

### Step 3 — Edge paths (clockwise)

Each edge curves from one node to the next:

| Edge | Path |
|------|------|
| node-1 → node-2 | `M 62,18 Q 72,22 75,30` |
| node-2 → node-3 | `M 82,42 Q 84,50 82,58` |
| node-3 → node-4 | `M 75,70 Q 68,80 58,82` |
| node-4 → node-5 | `M 42,82 Q 32,80 25,70` |
| node-5 → node-6 | `M 18,58 Q 16,50 18,42` |
| node-6 → node-1 | `M 25,30 Q 28,22 38,18` |

For **bidirectional** edges (full-duplex ring), add `marker-start` to each path.

### Step 4 — Cross-ring edges (optional)

For skip connections (e.g. leader → all followers), add straight or curved
paths that cross the center:

```html
<!-- Leader (node-1) broadcasts to node-4 (opposite) -->
<path class="fg-edge amber" d="M 50,22 L 50,78"
      marker-end="url(#fg-arr-amber-rr)"/>
```

---

## How to customise `layered.html`

4 horizontal layers stacked vertically. Each layer has a dashed frame +
label. Use for classic tiered architectures.

### Step 1 — Placeholders

| Placeholder | Example | Notes |
|-------------|---------|-------|
| `{{WRAP_TONE}}` | `amber` | container border color |
| `{{LAYER_1_LABEL}}` | `INGRESS` | top layer label |
| `{{LAYER_2_LABEL}}` | `ROUTER` | second layer |
| `{{LAYER_3_LABEL}}` | `WORKERS` | third layer |
| `{{LAYER_4_LABEL}}` | `STORAGE` | bottom layer |
| `{{LAYER_1_NODE_NAME}}` / `{{LAYER_1_NODE_SUB}}` | `gateway` / `nginx · TLS termination` | top node |
| `{{LAYER_2_NODE_NAME}}` / `{{LAYER_2_NODE_SUB}}` | `message-bus` / `NATS · subject routing` | center hub (pill) |
| `{{LAYER_3A_NAME}}` / `{{LAYER_3B_NAME}}` | `worker-a` / `worker-b` | side-by-side workers |
| `{{LAYER_4_NODE_NAME}}` / `{{LAYER_4_NODE_SUB}}` | `postgres` / `primary + replica` | bottom storage |
| `{{EDGE_1_TONE}}` / `{{EDGE_2_TONE}}` / `{{EDGE_3_TONE}}` | `cyan` / `amber` / `green` | vertical arrow colors |
| `{{EDGE_1_LABEL}}` / `{{EDGE_2_LABEL}}` / `{{EDGE_3_LABEL}}` | `request` / `dispatch` / `persist` | edge annotations |
| `{{LEGEND}}` | `request → router → workers → db` | bottom strip |

### Step 2 — 3-layer variant

Remove layer-4 (storage) for a simpler 3-tier:

1. Delete the layer-4 frame + label HTML
2. Delete the layer-4 node + fan-in arrows
3. Change container aspect from `tall` (4/5) → `square` (1/1)

### Step 3 — Fan-out / fan-in

Default layout has 1 → 1 → 2 → 1 nodes (fan-out to workers, fan-in to storage).
To change:

- **All layers single-node**: remove `{{LAYER_3B_*}}` node and one arrow from
  each fan-out/fan-in pair.
- **More workers**: add additional nodes at y=56 with x spaced evenly (20, 40,
  60, 80 for 4 workers).

---

## How to customise `machine-clusters.html`

3 machine frames side-by-side with cross-machine edges. Each frame has its
own dashed border + label.

### Step 1 — Placeholders

| Placeholder | Example | Notes |
|-------------|---------|-------|
| `{{WRAP_TONE}}` | `amber` | container border color |
| `{{MACHINE_1_LABEL}}` / `{{MACHINE_1_SUB}}` | `Machine-1` / `192.168.1.10` | left frame |
| `{{MACHINE_2_LABEL}}` / `{{MACHINE_2_SUB}}` | `Machine-2` / `192.168.1.11` | center frame |
| `{{MACHINE_3_LABEL}}` / `{{MACHINE_3_SUB}}` | `Machine-3` / `192.168.1.12` | right frame |
| `{{M1_NODE_1_NAME}}` / `{{M1_NODE_1_SUB}}` | `hub` / `pool manager` | machine-1 node |
| `{{M1_NODE_2_NAME}}` / `{{M1_NODE_2_SUB}}` | `adapter` / `telegram` | machine-1 second node |
| `{{M2_NODE_1_NAME}}` ... `{{M3_NODE_1_NAME}}` | ... | per-machine nodes |
| `{{MACHINE_1_EDGE_TONE}}` / `{{MACHINE_1_EDGE_LABEL}}` | `amber` / `internal` | intra-machine edge |
| `{{CROSS_1_TONE}}` / `{{CROSS_1_LABEL}}` | `cyan` / `replicate` | cross-machine edge 1 |
| `{{CROSS_2_TONE}}` / `{{CROSS_2_LABEL}}` | `purple` / `sync` | cross-machine edge 2 |
| `{{LEGEND}}` | `each machine runs hub + adapter · cross-machine sync via NATS` | bottom strip |

### Step 2 — 2-machine variant

Remove machine-3 for a simpler side-by-side:

1. Delete the machine-3 frame + nodes
2. Delete the `CROSS_2_*` edge + label
3. Adjust container width / frame positions

### Step 3 — Cross-machine edge routing

Edges bulge into the gaps between frames to avoid crossing nodes:

| Edge | Path | Bulge point |
|------|------|-------------|
| Machine-1 → Machine-2 | `M 22,50 Q 32,45 40,50` | x=32 (gap between frames) |
| Machine-2 → Machine-3 | `M 60,50 Q 67,45 75,50` | x=67 (gap between frames) |

The control point y=45 lifts the curve slightly above center for visual clarity.

---

## How to customise `deployment-tiers.html`

3 deployment tiers stacked vertically with colored stripes. Promotion arrows
flow upward; data sync arrows flow between tiers.

### Step 1 — Placeholders

| Placeholder | Example | Notes |
|-------------|---------|-------|
| `{{WRAP_TONE}}` | `amber` | container border color |
| `{{TIER_1_LABEL}}` / `{{TIER_1_SUB}}` | `PRODUCTION` / `live · users online` | top tier (green) |
| `{{TIER_2_LABEL}}` / `{{TIER_2_SUB}}` | `STAGING` / `pre-prod · QA testing` | middle tier (cyan) |
| `{{TIER_3_LABEL}}` / `{{TIER_3_SUB}}` | `DEV` / `local · development` | bottom tier (amber) |
| `{{TIER_1_SERVICE_NAME}}` / `{{TIER_1_SERVICE_SUB}}` | `lyra-hub-prod` / `p=100 · primary` | prod service |
| `{{TIER_1_DB_NAME}}` / `{{TIER_1_DB_SUB}}` | `postgres-prod` / `primary + replica` | prod database (pill) |
| `{{TIER_2_*}}` / `{{TIER_3_*}}` | ... | staging + dev nodes |
| `{{TIER_1_EDGE_LABEL}}` | `req ↔ db` | intra-tier edge label |
| `{{PROMOTE_1_LABEL}}` | `promote` | dev → staging arrow |
| `{{PROMOTE_2_LABEL}}` | `promote` | staging → prod arrow |
| `{{SYNC_LABEL}}` | `seed data` | prod → staging sync arrow |
| `{{LEGEND}}` | `promote upward · seed data downward · each tier isolated` | bottom strip |

### Step 2 — Tier tones (fixed)

Tiers use consistent colors for immediate recognition:

| Tier | Tone | CSS class |
|------|------|-----------|
| Production | green | `.fgraph-node.green` |
| Staging | cyan | `.fgraph-node.cyan` |
| Dev | amber | `.fgraph-node.amber` |

Data sync arrows use `purple` to distinguish from promotion flow.

### Step 3 — 2-tier variant

Remove the dev tier for a staging → prod view:

1. Delete tier-3 stripe + nodes
2. Delete `PROMOTE_1_*` placeholder and arrow
3. Adjust tier positions: prod at 20%, staging at 60%

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

## Extending the template set

All core topologies are now covered. If you need a new shape:

1. Start from the closest template
2. Reposition nodes via `--x`/`--y`
3. Adjust arrow paths to match
4. Add new CSS primitives to `fgraph-base.css` if needed (e.g. new tones, shapes)

Contributions welcome — mirror the `radial-hub.html` + README pattern.
