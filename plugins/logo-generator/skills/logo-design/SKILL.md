---
name: logo-design
description: 'Design an animated SVG logo with live preview and export to GIF/PNG/HTML — config-driven, interactive controls. Triggers: "logo" | "create logo" | "generate logo" | "brand logo" | "design logo" | "animated logo" | "logo export".'
version: 0.2.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch
---

# Logo Design (Animated SVG)

**Goal:** Create a production animated SVG logo with live interactive preview and export to GIF/PNG/HTML.

Let:
  BR := `$HOME/.roxabi-vault/config/logo-briefs`
  CH := `$HOME/.roxabi-vault/config/visual-charter.json`
  BD := `<project-root>/brand/`

## Phase 1 — Context Discovery

1. Identify target project: `$ARGUMENTS` name/path → cwd (`CLAUDE.md`, `README.md`, `package.json`, `pyproject.toml`).

2. Check brand assets:
```bash
ls "$HOME/.roxabi-vault/config/logo-briefs/" 2>/dev/null && echo "EXISTING_BRIEFS_FOUND" || echo "NO_BRIEFS"
charter="$HOME/.roxabi-vault/config/visual-charter.json"
[ -f "$charter" ] && echo "CHARTER_FOUND" && cat "$charter" || echo "NO_CHARTER"
```

3. ∃ brief for project → ask: "Found existing brief. Load it, or start fresh?"
4. Research project identity: read `CLAUDE.md`, `README.md`, docs, configs — extract purpose, architecture, metaphors, personality.

## Phase 2 — Creative Brief Intake

Present decisions via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A).

### 2.1 Identity
Confirm: **Name** (wordmark), **Tagline**, **Essence** (one sentence: what it is + how it should feel).

### 2.2 Metaphor Exploration
Propose 2-3 metaphors, each mapping to a visual shape connected to project architecture/purpose with literal + abstract readings. Ask user to pick or combine.

### 2.3 Colors
CH exists → propose using its colors. Otherwise propose 2-3 palettes, each with: **Primary** (input/energy), **Secondary** (output/intelligence), **Background** (near-black), **Surface** (inner frame), **Highlight** (nodes/text accents).

### 2.4 Frame & Typography
Ask: frame shape (hexagon/circle/rounded square/none); font direction (geometric sans vs. sharp sans vs. custom); connectors (yes/no).

### 2.5 Animation
Ask: speed (normal/fast/slow); idle effects (hub pulse, data particles, node breathing, border glow, background particles); particle density (sparse/normal/dense).

## Phase 3 — Brief Generation

Compose `logo-brief.json` using `${CLAUDE_PLUGIN_ROOT}/examples/logo-brief.example.json` schema. Translate metaphor → concrete SVG elements (paths, lines, nodes, coordinates). Set animation timing + idle parameters.

```bash
mkdir -p "$HOME/.roxabi-vault/config/logo-briefs"
# Save as <project-name>-logo-brief.json
```

## Phase 4 — Render & Preview

1. Create BD.
2. Read `${CLAUDE_PLUGIN_ROOT}/scripts/logo-engine.html`.
3. Inject `var LOGO_BRIEF = <brief>;` before `init();`.
4. Add before `</style>`:
```css
@keyframes wordmarkIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
```
5. Write to `BD/<name>-logo.html`; `xdg-open` it.
6. Tell user: "Preview is open. Use the gear icon (top-right) to tweak colors, sizes, and animation in real time."
7. Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Export GIF+PNG** (Phase 6) | **Tweak** (Phase 5) | **Start over** (Phase 2).

## Phase 5 — Iterate

Color/size tweaks → update brief + re-render. Shape changes → redesign mark elements. Metaphor changes → Phase 2.2. User exported brief from browser → load it as new source of truth.

## Phase 6 — Export

```bash
cp "${CLAUDE_PLUGIN_ROOT}/scripts/export-logo.mjs" "BD/capture-gif.mjs"
cp "${CLAUDE_PLUGIN_ROOT}/scripts/logo-engine.html" "BD/_logo-engine.html"
```

Patch `capture-gif.mjs`: replace `'logo-engine.html'` → `'_logo-engine.html'`; add `import { resolve } from 'path'`; wrap `tempHtml` with `resolve()`. Patch `_logo-engine.html`: add `@keyframes wordmarkIn` + `@keyframes fadeIn`.

```bash
cd "<project-root>" && npm list puppeteer 2>/dev/null || npm install --no-save puppeteer
node brand/capture-gif.mjs \
  "$HOME/.roxabi-vault/config/logo-briefs/<name>-logo-brief.json" \
  --output brand/ --gif --png --duration 8 --fps 15
```

Outputs: `<name>-logo.html`, `<name>-logo.gif`, `<name>-logo.png`.

## Phase 7 — Brand Identity Document

Generate `BD/BRAND-IDENTITY.md` with sections: Starting Point | Core Metaphor | Mark Anatomy | Colour System (table) | Typography | Animation | Design Principles.

$ARGUMENTS
