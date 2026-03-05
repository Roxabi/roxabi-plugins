# Visual Explainer

Generate self-contained HTML pages that visually explain systems, code, data, and concepts. Instead of ASCII art and box-drawing tables, get real diagrams with typography, dark/light themes, and interactive Mermaid charts.

Forked from [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer) (MIT).

## What it does

Takes any input (code, docs, concepts, data) and produces a standalone HTML page with:

- Mermaid.js diagrams (flowcharts, sequence, ER, state, mind maps, C4)
- Chart.js data visualizations (bar, line, pie, radar)
- CSS Grid layouts for architecture cards and dashboards
- Slide deck mode for presentations
- Dark/light theme support with responsive design
- Zoom and pan on all diagrams

Output is saved to `~/.agent/diagrams/` and opened in the browser.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install visual-explainer
```

## Usage

Trigger phrases:

- `diagram of our authentication flow`
- `visualize the data pipeline`
- `generate an architecture diagram`
- `generate HTML page for this data`

### Commands

| Command | What it does |
|---------|-------------|
| `/generate-web-diagram` | Generate an HTML diagram for any topic |
| `/generate-visual-plan` | Generate a visual implementation plan |
| `/generate-slides` | Generate a magazine-quality slide deck |
| `/diff-review` | Visual diff review with architecture comparison |
| `/plan-review` | Compare a plan against the codebase |
| `/project-recap` | Mental model snapshot for context-switching |
| `/fact-check` | Verify accuracy of a document against code |
| `/share` | Deploy an HTML page to Vercel and get a live URL |

### Slide deck mode

Any command supports `--slides` to generate a slide deck instead of a scrollable page:

```
/diff-review --slides
/project-recap --slides 2w
```

### Proactive table rendering

The skill also activates automatically when about to render a complex ASCII table (4+ rows or 3+ columns) — it generates an HTML page instead.

## How it works

```
skills/visual-explainer/
  SKILL.md              -- workflow + design principles
  references/           -- CSS patterns, library configs, slide engine
  templates/            -- reference HTML templates (architecture, mermaid, data-table, slides)
  scripts/share.sh      -- Vercel deploy script
commands/               -- slash commands
```

The skill reads the input, picks the right rendering approach (Mermaid for diagrams, CSS Grid for architecture, HTML tables for data, Chart.js for dashboards), generates a themed HTML file, and opens it in the browser.

## License

MIT
