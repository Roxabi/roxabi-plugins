# web-intel

Multi-platform URL scraper and content analysis engine for Claude Code. Extracts structured content from Twitter/X, GitHub, YouTube, Reddit, and any webpage — then powers 6 analysis skills on top.

## Skills

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/scrape <url>` | "scrape", "fetch url" | Raw structured extraction — returns JSON with content, metadata, platform-specific fields |
| `/summarize <url>` | "summarize url", "tldr" | Scrape → concise summary (key points, takeaways, who/what/why) |
| `/analyze-url <url>` | "analyze url", "deep dive url" | Scrape → deep analysis (tech stack, architecture, business model, competitive positioning) |
| `/roast <url>` | "roast", "critique site" | Scrape + screenshot → brutally honest critique (design, UX, copy, performance, a11y) |
| `/benchmark <url>` | "benchmark", "compare with" | Scrape + screenshot → compare against current repo (features, UI, stack, auth, UX). Gap report |
| `/adapt <url>` | "adapt", "inspire from" | Scrape → extract what works → suggest how to adapt patterns/copy/design for your project |

## Supported Platforms

| Platform | URLs | Key Fields |
|----------|------|------------|
| Twitter/X | x.com, twitter.com | text, author, thread reconstruction, articles |
| GitHub | github.com | README, stars, forks, language, topics |
| YouTube | youtube.com, youtu.be | title, transcript (with timestamps), duration |
| Reddit | reddit.com, redd.it | post, top comments, score, subreddit |
| Webpage | any HTTP(S) URL | extracted article text, title, author, metadata |

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) package manager

Optional:
- `gh` CLI (for GitHub repo scraping)
- `playwright` (for Twitter/X articles): `uv sync --extra twitter && playwright install chromium`
- `youtube-transcript-api` (for YouTube transcripts): `uv sync --extra youtube`
- `trafilatura` (for generic webpage extraction): `uv sync --extra scraper`

## Setup

```bash
cd plugins/web-intel
uv sync --extra all          # Install all optional dependencies
playwright install chromium  # Only if you need Twitter article support
```

## Usage

### CLI

```bash
cd plugins/web-intel
SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py <url>
```

### As Claude Code Skills

Once installed via the plugin, use any skill directly:

```
/scrape https://github.com/anthropics/claude-code
/summarize https://x.com/user/status/123
/roast https://competitor.com
/benchmark https://competitor.com --focus features
```

## Architecture

```
scripts/
├── scraper.py           # Main entry point — URL routing + CLI
├── fetchers/            # Platform-specific extractors
│   ├── base.py          # Abstract base class + shared utilities
│   ├── twitter.py       # Twitter/X (syndication API + FxTwitter + Playwright)
│   ├── github.py        # GitHub (gh CLI)
│   ├── gist.py          # GitHub Gists (gh API)
│   ├── youtube.py       # YouTube (oEmbed + transcript API)
│   ├── reddit.py        # Reddit (JSON API)
│   └── generic.py       # Any webpage (Trafilatura)
├── utils/
│   └── url_detector.py  # URL type detection for routing
└── _shared/             # Vendored security + caching utilities
    ├── content_cache.py # File-based response cache (~/.cache/roxabi/scraper)
    ├── fetch_base.py    # SSRF-protected HTTP fetch
    ├── validators*.py   # URL, SSRF, subprocess validation
    ├── sanitizers.py    # HTML/Markdown XSS sanitization
    ├── retry.py         # Exponential backoff for transient errors
    └── timeouts.py      # Configurable timeout management
```

## Cache

Responses are cached at `~/.cache/roxabi/scraper/` with configurable TTLs:
- Metadata: 1 hour
- Content: 24 hours

Configure via environment variables: `CACHE_DIR`, `CACHE_TTL_CONTENT`, `CACHE_ENABLED`.

## Security

- SSRF protection on all outbound requests
- Content size limits (5MB default)
- HTML/Markdown XSS sanitization on all extracted content
- URL shortener resolution with redirect limits
- No credentials stored from scraped sites
