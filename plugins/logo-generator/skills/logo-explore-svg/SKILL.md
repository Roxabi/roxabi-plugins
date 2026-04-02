---
name: logo-explore-svg
description: 'Generate 25+ programmatic SVG logo variations in a comparison gallery — explore shapes, topologies, palettes. Triggers: "logo shapes" | "svg logo gallery" | "shape exploration" | "dot and line logo" | "logo shape variations".'
version: 0.2.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch
---

# Logo Explore (SVG)

**Goal:** Generate 25+ programmatic SVG logo variations in a single gallery page for quick shape and color exploration.

## Phase 1 — Context Discovery

1. Identify target project: `$ARGUMENTS` name/path → cwd (`CLAUDE.md`, `README.md`, `package.json`, `pyproject.toml`).

2. Check brand assets:
```bash
charter="$HOME/.roxabi-vault/config/visual-charter.json"
[ -f "$charter" ] && echo "CHARTER_FOUND" && cat "$charter" || echo "NO_CHARTER"
```

3. Research project identity: read `CLAUDE.md`, `README.md`, docs, configs — extract metaphors, shapes, personality.

## Phase 2 — Theme Selection

Present via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern C):
- **Dot + Line** — nodes connected by thin lines (constellation, network, molecule, trinity)
- **Hex Cells** — hexagonal tessellation, honeycomb clusters, nested hexes
- **Concentric Rings** — orbital circles with satellite dots, ring networks
- **Geometric Shapes** — diamonds, pentagons, triangles with vertex dots
- **Mixed / Custom** — describe direction or combine themes

## Phase 3 — Palette Setup

Define 6 palettes to rotate across variations. CH exists → its colors as primary palette + 5 complementary alternatives. Otherwise:

```javascript
const PAL = {
  orange: { primary: "#FF6B35", secondary: "#FF8F5E", bg: "#0D0D0D", surface: "#1C1C1E", nameColor: "#FF6B35" },
  cyan:   { primary: "#06B6D4", secondary: "#67E8F9", bg: "#0A0F1A", surface: "#111827", nameColor: "#67E8F9" },
  purple: { primary: "#8B5CF6", secondary: "#C084FC", bg: "#0D0B14", surface: "#1A1625", nameColor: "#C084FC" },
  green:  { primary: "#4ADE80", secondary: "#22D3EE", bg: "#000000", surface: "#0A0A0A", nameColor: "#4ADE80" },
  gold:   { primary: "#F59E0B", secondary: "#FBBF24", bg: "#0D0B14", surface: "#1A1625", nameColor: "#FBBF24" },
  earth:  { primary: "#6B8F71", secondary: "#C4A87C", bg: "#1A1A18", surface: "#252520", nameColor: "#6B8F71" },
};
```

## Phase 4 — Generate Gallery

1. Read `${CLAUDE_PLUGIN_ROOT}/scripts/svg-gallery-template.html` as structural shell.
2. Write 25 card entries in 4-5 sections. ∀ card: unique SVG mark in `<svg viewBox="0 0 100 110">` (5-15 elements); label + concept description; palette rotation (6 palettes); number badge.

SVG helpers: `dot(cx,cy,r,fill,opacity)→<circle>`; `line(x1,y1,x2,y2,stroke,width,opacity)→<line>`; `connect(nodes,edges,primary,secondary,opts)→batch`. Vary one parameter per variation (count/density/rotation/palette/topology). Sections: e.g. "Core Form", "Clusters", "Density Variations", "Rotations", "Symbolic".

3. Write to `<project-root>/brand/svg-gallery.html`.
4. `xdg-open "<project-root>/brand/svg-gallery.html"`

## Phase 5 — Pick & Iterate

Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Pick favorites** (by number) | **New theme** | **Done**

- Favorites + new gallery → 25 variations on selected shapes (vary density/palette/rotation/hybridize).
- New theme → Phase 2.
- Done → summarize favorites; suggest: `/logo-design` for animated production logo, `/logo-explore-ai` for photorealistic AI render.

$ARGUMENTS
