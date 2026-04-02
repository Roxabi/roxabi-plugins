---
name: benchmark
argument-hint: '<url> [--focus <area>]'
description: Benchmark current repo against a live website — scrape, screenshot, compare features/UX/stack. Triggers: "benchmark" | "compare with" | "benchmark against" | "how do we compare".
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch
---

# Benchmark

Let:
  U := target URL
  F := focus area (ui | features | stack | performance | ux | all), default `all`

Scrape U → screenshot → analyze repo → compare → report.

## Entry

```
/benchmark https://example.com             → full benchmark
/benchmark https://example.com --focus ui   → UI/design focus
```

¬U → Ask directly (Pattern B — no protocol read needed). Parse `--focus <area>` if provided.

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

## Step 2 — Scrape Target

```bash
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

Parse JSON: `data.text` (features/copy/value props), `data.title`, `data.description`, `content_type`.
`success: false` → fall back to WebFetch.

## Step 3 — Screenshot

```bash
agent-browser open "$URL"
agent-browser wait --load networkidle
agent-browser screenshot --full /tmp/benchmark-screenshot.png
agent-browser snapshot -i
```

agent-browser unavailable → skip, note in report.

## Step 4 — Analyze Repo

Use Glob + Grep to build capability inventory: pages/routes, API modules, UI components, auth flows, i18n, email templates.

## Step 5 — Compare & Score

Build comparison matrix based on F:

| Dimension | Weight | What to compare |
|-----------|--------|-----------------|
| **Features** | 25% | Feature parity — what they have vs what we have |
| **UI/Design** | 20% | Component richness, design system, visual polish |
| **Stack** | 15% | Tech stack modernity, DX, build tooling |
| **Auth & Security** | 15% | Auth methods, RBAC, security headers |
| **Performance** | 10% | SSR, caching, bundle optimization signals |
| **UX Patterns** | 15% | Loading states, error handling, a11y, i18n |

∀ dimension → assign: **Ahead** | **Parity** | **Gap** | **Missing**

## Step 6 — Present Results

Output structured markdown: Target Overview → Comparison Matrix → Overall Score (weighted %) → Gap Analysis → Priority-ordered Recommendations.

Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Create issues for gaps** | **Deep-dive a dimension** | **Benchmark another URL** | **Done**

## Safety Rules

- Read-only repo analysis (no modifications)
- Single scrape per URL per invocation
- No credentials/tokens stored from scraped sites

$ARGUMENTS
