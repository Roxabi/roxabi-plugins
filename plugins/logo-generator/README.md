# Logo Generator

Generate logos using multiple techniques — AI image generation for concept exploration, programmatic SVG galleries for shape exploration, and animated SVG engine for production logos.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install logo-generator
```

## Usage

Say any of:
- "generate a logo for this project"
- "explore logo concepts"
- "create a logo"
- "brand logo"

Or use the slash command:
```
/logo [project-name-or-path]
```

## Modes

### Explore (AI) — Concept Exploration

Batch-generate 25+ logo concepts as raster images using Flux AI model. Best for rapid visual exploration when you don't know what direction to go.

- Claude researches your project and proposes 4-5 visual directions
- Writes optimized prompts for each direction with color specs from your visual charter
- Batch-generates images (~20s each on RTX 3080/4080/5070)
- Opens a comparison gallery with lightbox navigation
- Pick favorites, generate variations, or switch to SVG mode

### Explore (SVG) — Shape Exploration

Generate 25+ programmatic SVG variations in a single gallery page. Best for exploring shapes, topologies, and color combinations.

- Choose a theme: dot+line, hex cells, concentric rings, geometric shapes
- 25 variations with different parameters, organized by sections
- Multiple color palettes rotating across variations
- Pick favorites and develop them into animated production logos

### Design (SVG) — Production Logo

Create an animated SVG logo with live preview and export. This is the full creative brief workflow.

- Interactive intake: metaphor, colors, frame, typography, animation
- Live HTML preview with real-time controls panel
- Export to GIF, PNG, and standalone HTML
- Brand Identity document generation

## How It Works

1. **Context Discovery** — reads your project docs, visual charter, existing briefs
2. **Mode Selection** — choose Explore (AI), Explore (SVG), or Design
3. **Generation** — batch AI images, SVG gallery, or animated preview
4. **Iteration** — pick favorites, generate variations, switch modes
5. **Export** — GIF, PNG, HTML, Brand Identity document

You can switch between modes at any time. Take an AI concept and develop it as an animated SVG, or take an SVG shape and render it as a photorealistic AI image.

## Brief & Prompt Formats

**Logo brief** (Design mode): JSON file describing the animated SVG logo. See `examples/logo-brief.example.json`.

**Prompt file** (AI mode): Markdown with YAML frontmatter. See `examples/prompt.example.md`.

## Integration

- **visual-charter.json** — reads your existing visual charter for color consistency
- **imageCLI** — uses your imageCLI project's venv for AI generation (auto-discovered)
- **Vault storage** — briefs saved to `~/.roxabi-vault/config/logo-briefs/` for reuse

## Requirements

**All modes:**
- Modern browser (for previews and galleries)

**AI exploration mode (additional):**
- CUDA-capable GPU with 10+ GB VRAM
- imageCLI project with torch/diffusers venv (auto-discovered at `~/projects/imageCLI/.venv`)

**Export (additional):**
- Google Chrome or Chromium
- ffmpeg (for GIF encoding)
- Node.js + Puppeteer (auto-installed on first export)
