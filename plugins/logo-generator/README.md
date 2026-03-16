# Logo Generator

Generate animated SVG logos from a config-driven brand brief — interactive design with live preview, GIF/PNG export.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install logo-generator
```

## Usage

Say any of:
- "generate a logo for this project"
- "create a logo"
- "brand logo"

Or use the slash command:
```
/logo [project-name-or-path]
```

## How It Works

### 1. Research Phase
Claude reads your project's docs (CLAUDE.md, README, architecture) to understand what it does and how it should feel.

### 2. Creative Brief
Interactive intake session where you choose:
- **Core metaphor** — the visual concept (convergence, constellation, lyre, circuit, etc.)
- **Color palette** — primary/secondary with emotional rationale
- **Frame shape** — hexagon, circle, rounded square, or none
- **Typography** — font family, weight, tracking
- **Animation** — speed, idle effects, particle density

### 3. Live Preview
Opens an interactive HTML preview in your browser with a controls panel:
- Color pickers for all palette colors
- Sliders for node sizes, glow intensity, border width
- Animation speed and toggle switches
- Export the tweaked brief back to JSON

### 4. Export
Produces:
- `<name>-logo.html` — standalone animated preview (shareable)
- `<name>-logo.gif` — animated GIF
- `<name>-logo.png` — static snapshot
- `BRAND-IDENTITY.md` — full creative process document

## Brief Format

The logo brief is a JSON file that describes everything about the logo. See `examples/logo-brief.example.json` for the full schema.

Key sections:
- **identity** — name, tagline, essence
- **colors** — primary, secondary, background, surface, highlight
- **frame** — shape, border, connectors
- **mark** — SVG elements (paths, lines), nodes, hub
- **animation** — intro sequence timing, idle loop config
- **export** — GIF settings, variants

## Integration

- **visual-charter.json** — if you use the `image-prompt-generator` plugin, the logo generator reads your existing visual charter for color consistency
- **Vault storage** — briefs are saved to `~/.roxabi-vault/config/logo-briefs/` for reuse across sessions

## Requirements

- Google Chrome or Chromium (for GIF export)
- ffmpeg (for GIF encoding)
- Node.js + Puppeteer (auto-installed on first export)
