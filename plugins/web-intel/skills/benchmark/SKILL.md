---
name: benchmark
argument-hint: '<url> [--focus <area>]'
description: Benchmark current repo against a live website — scrape, screenshot, compare features/UX/stack. Triggers: "benchmark" | "compare with" | "benchmark against" | "how do we compare".
version: 0.1.0
allowed-tools: Bash, AskUserQuestion, Read, Write, Edit, Glob, Grep, WebFetch
---

# Benchmark

Let:
  U := target URL
  B := agent-browser CLI
  F := optional focus area (ui | features | stack | performance | ux | all)

Scrape target URL → screenshot → analyze repo capabilities → compare → generate report.

## Entry

```
/benchmark https://example.com             → full benchmark
/benchmark https://example.com --focus ui   → UI/design focus
```

## Step 0 — Parse Input

Extract U from arguments. If no URL provided → `AskUserQuestion` to get one.

Parse optional `--focus <area>` flag. Default F = `all`.

## Step 1 — Scrape Target

```bash
PLUGIN_ROOT=$(find ~/projects -maxdepth 4 -path "*/web-intel/pyproject.toml" -print -quit 2>/dev/null | xargs dirname)
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

Parse JSON output. Extract:
- `data.text` → main content (features, copy, value props)
- `data.title` → page title
- `data.description` → meta description
- `content_type` → source type

If `success: false` → fall back to WebFetch tool for content extraction.

## Step 2 — Screenshot & Visual Capture

Use agent-browser to capture visual state:

```bash
agent-browser open "$URL"
agent-browser wait --load networkidle
agent-browser screenshot --full /tmp/benchmark-screenshot.png
agent-browser snapshot -i
```

If agent-browser unavailable → skip visual capture, note in report.

## Step 3 — Analyze Current Repo

Scan the project repo to build a capability inventory:

- **Pages/routes** → feature surface area
- **API modules** → backend capabilities
- **UI components** → design system coverage
- **Auth flows** → authentication patterns
- **i18n** → localization support
- **Email templates** → transactional email coverage

Use Glob and Grep to discover these patterns.

## Step 4 — Compare & Score

Build a comparison matrix across dimensions based on F:

| Dimension | Weight | What to compare |
|-----------|--------|-----------------|
| **Features** | 25% | Feature parity — what they have vs what we have |
| **UI/Design** | 20% | Component richness, design system, visual polish |
| **Stack** | 15% | Tech stack modernity, DX, build tooling |
| **Auth & Security** | 15% | Auth methods, RBAC, security headers |
| **Performance** | 10% | SSR, caching, bundle optimization signals |
| **UX Patterns** | 15% | Loading states, error handling, a11y, i18n |

For each dimension, assign:
- **Ahead** — our repo has stronger implementation
- **Parity** — roughly equivalent
- **Gap** — target has something we lack
- **Missing** — target has it, we don't at all

## Step 5 — Present Results

Output structured markdown with:
1. **Target Overview** — what the site is/does
2. **Comparison Matrix** — dimension-by-dimension table
3. **Overall Score** — weighted percentage
4. **Gap Analysis** — what they have that we don't, and vice versa
5. **Actionable Recommendations** — priority-ordered improvements

`AskUserQuestion`: Create issues for gaps? | Deep-dive a dimension? | Benchmark another URL? | Done

## Safety Rules

- Read-only analysis of the repo (no modifications)
- Single scrape per URL per invocation
- No credentials or tokens stored from scraped sites

$ARGUMENTS
