---
name: frontend-slides
description: 'Create stunning, animation-rich HTML presentations from scratch or by converting PowerPoint files. Triggers: "create slides" | "make a presentation" | "frontend-slides" | "convert pptx" | "pitch deck" | "slide deck".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---

# Frontend Slides

Let:
  VP := viewport fitting invariants
  DL := content density limits per slide

Create zero-dependency, animation-rich HTML presentations that run entirely in the browser.

## Core Principles

1. **Zero Dependencies** — Single HTML files with inline CSS/JS. ¬npm, ¬build tools.
2. **Show, Don't Tell** — Generate visual previews, not abstract choices.
3. **Distinctive Design** — ¬generic "AI slop." Every presentation feels custom-crafted.
4. **VP (NON-NEGOTIABLE)** — Every slide MUST fit exactly within 100vh. ¬scrolling within slides. Content overflows → split into multiple slides.

## Design Aesthetics

Avoid "AI slop" aesthetic — make creative, distinctive frontends that surprise and delight.

- **Typography**: beautiful, unique fonts — ¬Arial, ¬Inter, ¬generic system fonts
- **Color & Theme**: cohesive aesthetic with CSS variables; dominant colors + sharp accents; draw from IDE themes / cultural aesthetics
- **Motion**: CSS-only animations; prioritize page-load staggered reveals over scattered micro-interactions
- **Backgrounds**: atmosphere + depth via CSS gradients, geometric patterns, contextual effects

Avoid: overused fonts (Inter, Roboto, Arial) | cliché color schemes (purple gradients on white) | predictable layouts | Space Grotesk convergence. Think outside the box — vary light/dark themes, fonts, aesthetics per generation.

## VP Rules (∀ slide)

- `.slide` → `height: 100vh; height: 100dvh; overflow: hidden;`
- ALL font sizes/spacing → `clamp(min, preferred, max)` — ¬fixed px/rem
- Content containers need `max-height` constraints
- Images: `max-height: min(50vh, 400px)`
- Breakpoints required for heights: 700px, 600px, 500px
- Include `prefers-reduced-motion` support
- ¬negate CSS functions directly (`-clamp()` silently ignored) → use `calc(-1 * clamp(...))`

**Before generating, read `viewport-base.css` and include its full contents in every presentation.**

### DL Per Slide

| Slide Type | Maximum Content |
|------------|-----------------|
| Title | 1 heading + 1 subtitle + optional tagline |
| Content | 1 heading + 4-6 bullets OR 1 heading + 2 paragraphs |
| Feature grid | 1 heading + 6 cards max (2×3 or 3×2) |
| Code | 1 heading + 8-10 lines of code |
| Quote | 1 quote (max 3 lines) + attribution |
| Image | 1 heading + 1 image (max 60vh) |

Content exceeds DL → split. ¬cram, ¬scroll.

---

## Phase 0: Detect Mode

- **Mode A: New Presentation** → Phase 1
- **Mode B: PPT Conversion** → Phase 4
- **Mode C: Enhancement** → read existing, enhance per Mode C rules

### Mode C Rules

VP is the biggest risk when enhancing:

1. Before adding content: count elements, check against DL
2. Adding images: `max-height: min(50vh, 400px)`. Slide at max content → split first
3. Adding text: max 4-6 bullets. Exceeds DL → split into continuation slides
4. After ANY modification verify: `.slide` has `overflow: hidden` | new elements use `clamp()` | images have viewport-relative max-height | fits at 1280×720
5. Modifications will cause overflow → auto-split and inform user. ¬wait to be asked

Adding images to existing slides → move image to new slide or reduce other content first.

---

## Phase 1: Content Discovery (New Presentations)

Ask ALL questions in a single AskUserQuestion call:

- **Purpose**: Pitch deck / Teaching-Tutorial / Conference talk / Internal
- **Length**: Short 5-10 / Medium 10-20 / Long 20+
- **Content**: All ready / Rough notes / Topic only
- **Inline Editing**: Yes (Recommended — edit in-browser, auto-save to localStorage, export) / No

Remember editing choice — determines whether edit-related code is included in Phase 3. Content ∃ → ask user to share it.

### Step 1.2: Image Evaluation

User selected "No images" → skip to Phase 2.

User provides image folder:
1. Scan — list all image files (.png, .jpg, .svg, .webp, etc.)
2. View each via Read tool (multimodal)
3. ∀ image: what it shows | USABLE / NOT USABLE (with reason) | concept | dominant colors
4. Co-design outline — curated images inform slide structure alongside text (¬"plan slides then add images" — design around both from start)
5. AskUserQuestion (header: "Outline"): "Does this slide outline and image selection look right?" Options: Looks good / Adjust images / Adjust outline

Logo ∃ → embed (base64) into each Phase 2 style preview.

---

## Phase 2: Style Discovery

### Step 2.0: Style Path

Ask (header: "Style"): "Show me options" (recommended) / "I know what I want"

Direct selection → show preset picker from [STYLE_PRESETS.md](STYLE_PRESETS.md) → skip to Phase 3.

### Step 2.1: Mood Selection

Ask (header: "Vibe", multiSelect, max 2):
- Impressed/Confident — professional, trustworthy
- Excited/Energized — innovative, bold
- Calm/Focused — clear, thoughtful
- Inspired/Moved — emotional, memorable

### Step 2.2: Generate 3 Style Previews

Read [STYLE_PRESETS.md](STYLE_PRESETS.md). Generate 3 distinct single-slide HTML previews (typography, colors, animation, overall aesthetic).

| Mood | Suggested Presets |
|------|-------------------|
| Impressed/Confident | Bold Signal, Electric Studio, Dark Botanical |
| Excited/Energized | Creative Voltage, Neon Cyber, Split Pastel |
| Calm/Focused | Notebook Tabs, Paper & Ink, Swiss Modern |
| Inspired/Moved | Dark Botanical, Vintage Editorial, Pastel Geometry |

Save → `.claude-design/slide-previews/` (style-a.html, style-b.html, style-c.html) — self-contained, ~50-100 lines, one animated title slide each. Open each automatically.

### Step 2.3: User Picks

Ask (header: "Style"): Style A: [Name] / Style B: [Name] / Style C: [Name] / Mix elements

"Mix elements" → ask for specifics.

---

## Phase 3: Generate Presentation

Use content from Phase 1 + style from Phase 2. Images ∃ → outline already incorporates them from Step 1.2. ∄ → CSS-generated visuals (gradients, shapes, patterns) — fully supported.

Read before generating:
- [html-template.md](html-template.md) — HTML architecture and JS features
- [viewport-base.css](viewport-base.css) — Mandatory CSS (include in full)
- [animation-patterns.md](animation-patterns.md) — Animation reference for chosen feeling

Requirements: single self-contained HTML | full viewport-base.css in `<style>` | fonts from Fontshare or Google Fonts | detailed comments | `/* === SECTION NAME === */` per section.

---

## Phase 4: PPT Conversion

1. Extract: `python scripts/extract-pptx.py <input.pptx> <output_dir>` (install python-pptx if needed: `pip install python-pptx`)
2. Confirm — present extracted slide titles, content summaries, image counts
3. Style selection → Phase 2
4. Generate HTML — preserve text, images (from assets/), slide order, speaker notes (as HTML comments)

---

## Phase 5: Delivery

1. Delete `.claude-design/slide-previews/` if ∃
2. `open [filename].html`
3. Report: file location | style name | slide count | navigation (arrows, space, scroll/swipe, nav dots) | customization (`:root` CSS vars, font link, `.reveal` class) | edit mode if enabled (hover top-left or E → edit mode, click text to edit, Ctrl+S to save)

---

## Supporting Files

| File | Purpose | When |
|------|---------|------|
| [STYLE_PRESETS.md](STYLE_PRESETS.md) | 12 curated visual presets | Phase 2 |
| [viewport-base.css](viewport-base.css) | Mandatory responsive CSS | Phase 3 |
| [html-template.md](html-template.md) | HTML structure, JS features | Phase 3 |
| [animation-patterns.md](animation-patterns.md) | CSS/JS animation snippets | Phase 3 |
| [scripts/extract-pptx.py](scripts/extract-pptx.py) | PPT content extraction | Phase 4 |
