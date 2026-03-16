---
name: logo
description: 'Generate animated SVG logos from a brand brief — interactive design, live preview, GIF export. Triggers: "logo" | "generate logo" | "create logo" | "brand logo" | "logo generator".'
version: 0.1.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch, AskUserQuestion
---

# Logo Generator

**Goal:** Generate a config-driven animated SVG logo for any project, with live preview and export to GIF/PNG/HTML.

## Phase 1 — Context Discovery

1. Identify the target project. Check (in order):
   - `$ARGUMENTS` for a project name or path
   - Current working directory for `CLAUDE.md`, `README.md`, `package.json`, `pyproject.toml`

2. Check for existing brand assets:

```bash
# Check for existing logo brief
brief="$HOME/.roxabi-vault/config/logo-briefs"
ls "$brief/" 2>/dev/null && echo "EXISTING_BRIEFS_FOUND" || echo "NO_BRIEFS"

# Check for visual charter (shared with image-prompt-generator)
charter="$HOME/.roxabi-vault/config/visual-charter.json"
[ -f "$charter" ] && echo "CHARTER_FOUND" && cat "$charter" || echo "NO_CHARTER"
```

3. If an existing brief is found for this project, ask: "Found existing brief. Load it, or start fresh?"

4. Research the project to understand its identity:
   - Read `CLAUDE.md`, `README.md`, docs, config files
   - Understand what the project does, its architecture, key concepts
   - Identify potential metaphors, shapes, and personality traits

## Phase 2 — Creative Brief Intake

Use `AskUserQuestion` for each decision. Present options with clear rationale.

### 2.1 Identity

Ask for or confirm:
- **Name** — project name as it should appear in the wordmark
- **Tagline** — short descriptor (e.g., "AI Workflow Orchestration")
- **Essence** — one sentence capturing what the project is and how it should feel

### 2.2 Metaphor Exploration

Based on the project research, propose 2-3 core metaphors. Each metaphor should:
- Map naturally to a visual shape
- Connect to the project's architecture or purpose
- Have both literal and abstract readings

Example format:
```
Metaphor A: "Convergence" (V-shape)
  Why: Multiple pipelines merge into one output
  Shape: Two arms descending to a single apex node

Metaphor B: "Lyre" (stringed instrument)
  Why: Name reference + harmony of multiple channels
  Shape: Curved arms with strings connecting to a base hub

Metaphor C: "Constellation" (star network)
  Why: Always-on presence + connected nodes
  Shape: Central bright node with radiating connections
```

Ask the user to pick one or combine elements.

### 2.3 Colors

If a visual charter exists, propose using its colors. Otherwise:

Propose 2-3 color palettes with rationale. Each palette needs:
- **Primary** — the input/activity/energy color
- **Secondary** — the output/resolution/intelligence color
- **Background** — page background (near-black recommended)
- **Surface** — inner frame fill
- **Highlight** — node centres, text accents

Explain the emotional meaning of each pairing (e.g., "Teal/amber = electric + warm", "Cyan/violet = digital + cognitive").

### 2.4 Frame & Typography

Ask preferences:
- **Frame shape** — hexagon (technical), circle (organic), rounded square (modern), none
- **Font direction** — geometric sans-serif (Century Gothic, Questrial) vs. sharp sans (Inter, DM Sans) vs. custom
- **Connectors** — pipeline lines extending from frame (yes/no)

### 2.5 Animation

Ask:
- **Animation speed** — normal / fast / slow
- **Idle effects** — which to include: hub pulse, data particles, node breathing, border glow, background particles
- **Particle density** — sparse / normal / dense

## Phase 3 — Brief Generation

Compose the full `logo-brief.json` from all answers. Use the schema at `${CLAUDE_PLUGIN_ROOT}/examples/logo-brief.example.json` as reference.

Key decisions to make during brief generation:
- Translate the chosen metaphor into concrete SVG elements (paths, lines, nodes)
- Design the mark geometry — actual SVG `d` attributes for paths, coordinates for nodes
- Set animation timing sequence
- Configure idle animation parameters

Save the brief:

```bash
mkdir -p "$HOME/.roxabi-vault/config/logo-briefs"
# Save as <project-name>-logo-brief.json
```

## Phase 4 — Render & Preview

1. Copy the logo engine into the project's brand directory:

```bash
brand_dir="<project-root>/brand"
mkdir -p "$brand_dir"
```

2. Generate the preview HTML by injecting the brief into the engine template:
   - Read `${CLAUDE_PLUGIN_ROOT}/scripts/logo-engine.html`
   - Inject the brief as `var LOGO_BRIEF = <brief>;` before the init call
   - Write the result to `<project-root>/brand/<name>-logo.html`

3. Open in browser for live preview:

```bash
xdg-open "<project-root>/brand/<name>-logo.html" 2>/dev/null || \
open "<project-root>/brand/<name>-logo.html" 2>/dev/null || \
echo "Open in browser: <project-root>/brand/<name>-logo.html"
```

4. **IMPORTANT:** When injecting into the engine template, add these CSS keyframes inside the `<style>` block (after `* { margin: 0; ... }`). The engine template does not include them:

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

5. Tell the user: "Preview is open. Use the gear icon (top-right) to tweak colors, sizes, and animation in real time. When you're happy, say 'export' or tell me what to change."

6. After showing the preview, ask the user via `AskUserQuestion`:
   - **"What's next?"** with options:
     - "Export GIF + PNG" — proceed to Phase 6
     - "Tweak it" — proceed to Phase 5
     - "Start over" — go back to Phase 2

## Phase 5 — Iterate

If the user wants changes:
- For color/size tweaks: update the brief and re-render
- For shape changes: redesign the mark elements in the brief
- For metaphor changes: go back to Phase 2.2

If the user used the controls panel and exported a brief from the browser, load that brief and use it as the new source of truth.

## Phase 6 — Export

When the user is satisfied, run the export pipeline:

1. Copy the export script and engine locally (the script resolves the engine from `__dirname`, and Puppeteer must be installed in the project's `node_modules`):

```bash
cp "${CLAUDE_PLUGIN_ROOT}/scripts/export-logo.mjs" "<project-root>/brand/capture-gif.mjs"
cp "${CLAUDE_PLUGIN_ROOT}/scripts/logo-engine.html" "<project-root>/brand/_logo-engine.html"
```

2. Patch `capture-gif.mjs`: replace `'logo-engine.html'` with `'_logo-engine.html'` in the `readFileSync` call, and add `import { resolve } from 'path'` then wrap `tempHtml` with `resolve()` so Puppeteer gets an absolute `file://` path.

3. Patch `_logo-engine.html`: add the `@keyframes wordmarkIn` and `@keyframes fadeIn` CSS (same as Phase 4 step 4).

4. Install Puppeteer and run:

```bash
cd "<project-root>" && npm list puppeteer 2>/dev/null || npm install --no-save puppeteer

node brand/capture-gif.mjs \
  "$HOME/.roxabi-vault/config/logo-briefs/<name>-logo-brief.json" \
  --output brand/ \
  --gif --png --duration 8 --fps 15
```

5. Verify the outputs exist and show the PNG to the user for confirmation.

This produces:
- `<name>-logo.html` — standalone animated preview
- `<name>-logo.gif` — animated GIF for sharing
- `<name>-logo.png` — static snapshot

## Phase 7 — Brand Identity Document

Generate a `BRAND-IDENTITY.md` following the Valora/Lyra creative process format:

1. Starting Point — what the project does and how it should feel
2. Core Metaphor — why this shape was chosen
3. Mark Anatomy — every element explained (frame, arms, nodes, hub, etc.)
4. Colour System — table of all colors with roles
5. Typography — font choices and rationale
6. Animation — intro sequence + idle loops explained
7. Design Principles — rules for extending the identity

Save to `<project-root>/brand/BRAND-IDENTITY.md`.

$ARGUMENTS
