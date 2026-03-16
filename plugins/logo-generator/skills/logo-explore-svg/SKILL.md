---
name: logo-explore-svg
description: 'Generate 25+ programmatic SVG logo variations in a comparison gallery — explore shapes, topologies, palettes. Triggers: "logo shapes" | "svg logo gallery" | "shape exploration" | "dot and line logo" | "logo shape variations".'
version: 0.2.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch, AskUserQuestion
---

# Logo Explore (SVG)

**Goal:** Generate 25+ programmatic SVG logo variations in a single gallery page for quick shape and color exploration.

## Phase 1 — Context Discovery

1. Identify the target project. Check (in order):
   - `$ARGUMENTS` for a project name or path
   - Current working directory for `CLAUDE.md`, `README.md`, `package.json`, `pyproject.toml`

2. Check for brand assets:

```bash
charter="$HOME/.roxabi-vault/config/visual-charter.json"
[ -f "$charter" ] && echo "CHARTER_FOUND" && cat "$charter" || echo "NO_CHARTER"
```

3. Research the project to understand its identity:
   - Read `CLAUDE.md`, `README.md`, docs, config files
   - Identify potential metaphors, shapes, and personality traits

## Phase 2 — Theme Selection

Ask the user for a shape theme via `AskUserQuestion`:
- **Dot + Line** — nodes connected by thin lines (constellation, network, molecule, trinity)
- **Hex Cells** — hexagonal tessellation, honeycomb clusters, nested hexes
- **Concentric Rings** — orbital circles with satellite dots, ring networks
- **Geometric Shapes** — diamonds, pentagons, triangles with vertex dots
- **Mixed / Custom** — describe a visual direction or combine themes

## Phase 3 — Palette Setup

Define 6 color palettes to rotate across variations. If a visual charter exists, extract its colors as the primary palette and generate 5 complementary alternatives. Otherwise, propose:

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

Generate 25 SVG variations in a single HTML page:

1. Read `${CLAUDE_PLUGIN_ROOT}/scripts/svg-gallery-template.html` as the structural shell
2. Write 25 card entries organized into 4-5 sections
3. Each card has:
   - A unique SVG mark in `<svg viewBox="0 0 100 110">` (vary node count, positions, connections, sizes, rotations)
   - A label and concept description
   - A color palette assignment (rotate across 6 palettes)
   - A number badge

SVG generation rules:
- Use helper functions for consistency:
  - `dot(cx, cy, r, fill, opacity)` → `<circle>`
  - `line(x1, y1, x2, y2, stroke, width, opacity)` → `<line>`
  - `connect(nodes, edges, primary, secondary, opts)` → batch dots + lines
- Keep marks simple: 5-15 elements per variation
- Vary systematically: one parameter changes per variation (count, density, rotation, palette, topology)
- Organize into sections (e.g., "Core Form", "Clusters", "Density Variations", "Rotations", "Symbolic")

4. Write the complete HTML to `<project-root>/brand/svg-gallery.html`
5. Open in browser: `xdg-open "<project-root>/brand/svg-gallery.html"`

## Phase 5 — Pick & Iterate

Ask via `AskUserQuestion`: "Pick favorites by number, new theme, or done?"

- **Pick favorites + new gallery:** Generate 25 new variations focused on the selected shapes — vary density, palette, rotation, hybridize favorites
- **New theme:** Go back to Phase 2
- **Done:** Summarize the selected favorites. Suggest next steps:
  - "Use `/logo-design` to develop a favorite into an animated production logo"
  - "Use `/logo-explore-ai` to render a favorite as a photorealistic AI image"

$ARGUMENTS
