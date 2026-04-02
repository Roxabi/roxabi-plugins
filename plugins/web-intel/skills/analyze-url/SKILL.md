---
name: analyze-url
argument-hint: '<url>'
description: Deep analysis of a URL — tech stack, architecture, business model, competitive positioning. Triggers: "analyze url" | "deep dive url" | "analyze this site".
version: 0.1.0
allowed-tools: Bash, Read
---

# Analyze URL

Scrape URL → deep technical and strategic analysis.

## Entry

```
/analyze-url https://example.com
```

¬U → Ask directly (Pattern B — no protocol read needed) to get one.

## Step 1 — Locate Plugin

```bash
PLUGIN_ROOT=$(find ~/projects -maxdepth 4 -path "*/web-intel/pyproject.toml" -print -quit 2>/dev/null | xargs dirname)
if [ -z "$PLUGIN_ROOT" ]; then
  echo "ERROR: web-intel plugin not found. Install: claude plugin install web-intel"
  exit 1
fi
```

## First Use

First invocation in session only:

```bash
cd "$PLUGIN_ROOT" && uv run python scripts/doctor.py
```

- exit 1 → show output, stop, guide install. Optional warnings → inform user, continue.
- Skip on subsequent invocations.

## Step 2 — Scrape

```bash
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

## Step 3 — Deep Analysis

### SaaS / Product URLs
1. Product overview — what, audience, value prop
2. Tech stack signals — frameworks, infra, CDN, visible APIs
3. Architecture patterns — SPA vs SSR, API-first, microservices signals
4. Business model — pricing, freemium, enterprise, self-serve
5. Competitive positioning — market category, differentiation, moat
6. Growth signals — community size, hiring, funding, integrations
7. Strengths (3-5 bullets) | Weaknesses (3-5 bullets)

### GitHub Repos
1. Project health — stars, forks, recent activity, contributor count
2. Architecture — language, framework, project structure
3. Code quality signals — CI/CD, tests, linting, type safety
4. Documentation — README quality, docs site, examples
5. Community — issues, PRs, discussions activity
6. Notable patterns worth adopting

### YouTube Videos

Run full video analysis pipeline:

```bash
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/video_analyzer.py "$URL" --output /tmp/video_analysis.json
```

Pipeline: scrape metadata + transcript → download video (yt-dlp, 1080p max) → extract frames at 1fps (ffmpeg) → auto-detect best local VLM by GPU VRAM (qwen3-vl via Ollama) → batch-describe frames → output JSON.

Read `/tmp/video_analysis.json` → analyze:
1. Video overview — title, channel, duration, views, engagement rate
2. Content analysis — thesis, structure, rhetorical techniques (from transcript)
3. Visual analysis — techniques (3D/2D/photography), palette, composition, transitions (from frames)
4. Production quality — animation, visual variety, text/typography, pacing
5. Scene breakdown — visual timeline mapped to narration
6. Strengths (3-5) | Weaknesses (3-5)

video_analyzer fails (¬GPU ∨ ¬Ollama) → fall back to transcript-only via standard scraper.

### Articles / Content
1. Thesis — main argument or claim
2. Evidence quality — data, sources, methodology
3. Implications — what this means for the field
4. Counter-arguments — what the author missed
5. Actionable insights

## Step 4 — Present

Output structured markdown with clear headers. Include confidence (high|medium|low) for inferred info.
`success: false` → fall back to WebFetch.

$ARGUMENTS
