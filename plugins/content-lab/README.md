# Content Lab

Analyze video content to extract creation recipes — narrative structure, VAKOG sensory predicates, and reusable techniques.

## What it does

Takes a YouTube video URL, scrapes the transcript, and produces a multi-dimensional analysis:

1. **VAKOG Profile** — maps which sensory systems the creator activates (Visual, Auditory, Kinesthetic, Auditory Digital) with global distribution and temporal choreography
2. **Narrative Structure** — identifies hook, setup, body, relances, CTA, and close phases with timing
3. **Technique Detection** — spots patterns like external metaphors, stat-shock cascades, branded concepts, audience segmentation, military lexical fields, cross-video callbacks
4. **Reusable Recipe** — synthesizes findings into an actionable creation template

## Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| `video-recipe` | `/video-recipe <url>` | Full video analysis → VAKOG + structure + recipe |
| `voice-style` | `/voice-style <transcript-path>` | Extract a creator's writing-style card from a transcript file — register, fillers, code-switching, sentence shape, signature moves. Acquire transcript via Phase 1.1 (yt-dlp / web-intel:scrape) first. |

### Flags

- `--html` — generate visual HTML report via visual-explainer + gui.new
- `--compare` — compare with previously analyzed videos
- `--list` — list all stored analyses

## Prerequisites

- Python >= 3.11
- uv package manager
- `web-intel` plugin (for YouTube scraping)

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install content-lab
```

## Usage

```bash
# Analyze a video
/video-recipe https://youtube.com/watch?v=...

# Analyze with visual HTML output
/video-recipe https://youtube.com/watch?v=... --html

# Compare with previous analyses
/video-recipe https://youtube.com/watch?v=... --compare

# List all analyzed videos
/video-recipe --list
```

## Dependencies

- **web-intel** — YouTube transcript scraping (required)
- **visual-explainer** — HTML report generation (optional, for `--html` flag)

## Doctor

```bash
cd plugins/content-lab && uv run python scripts/doctor.py
```

## License

MIT
