# Frontend Slides

A Claude Code plugin for creating zero-dependency, animation-rich HTML presentations — from scratch or by converting PowerPoint files.

Forked from [zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides) (MIT).

## What it does

Non-designers can create beautiful web presentations without knowing CSS or JavaScript. Instead of asking you to describe your aesthetic preferences in words, the plugin generates visual previews and lets you pick what you like.

When you trigger the skill, it:

1. **Discovers your content** — asks about purpose, length, and what you have ready
2. **Selects a visual style** — generates 3 animated single-slide previews based on the mood you want
3. **Generates the full presentation** — a single self-contained HTML file, no npm, no build tools
4. **Opens it in your browser** — ready to present or share

It also converts existing PowerPoint files to web, preserving all text, images, and speaker notes.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install frontend-slides
```

## Usage

Trigger with any of these phrases:

- `create slides`
- `make a presentation`
- `frontend-slides`
- `convert pptx`
- `pitch deck`
- `slide deck`

## Included styles

12 curated presets across dark, light, and specialty themes — Bold Signal, Electric Studio, Neon Cyber, Notebook Tabs, Swiss Modern, Paper & Ink, and more. Each is designed to avoid generic AI aesthetics.

## How it works

The skill uses progressive disclosure — the main SKILL.md is a concise map, with supporting files (style presets, CSS, HTML template, animation patterns) loaded on-demand only when needed.

- `STYLE_PRESETS.md` — 12 curated visual presets (loaded at style selection)
- `viewport-base.css` — mandatory responsive CSS included in every presentation
- `html-template.md` — HTML structure and JS features reference
- `animation-patterns.md` — CSS/JS animation reference
- `scripts/extract-pptx.py` — PPT extraction (requires `python-pptx`)

Output is always a single HTML file — inline CSS/JS, no dependencies, works in 10 years.

## License

MIT
