---
name: scrape
argument-hint: '<url>'
description: Extract structured content from a URL — Twitter/X, GitHub, YouTube, Reddit, or any webpage. Triggers: "scrape" | "fetch url" | "extract content" | "scrape https://" | "get content from" | "extract this page" | "pull data from" | "fetch this page".
version: 0.1.0
allowed-tools: Bash, Read
---

# Scrape

Extract structured content from a URL → JSON with content, metadata, and platform-specific fields.

## Entry

```
/scrape https://example.com
```

¬U → → DP(B)to get one.

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

## Step 2 — Run Scraper

```bash
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

## Step 3 — Present Results

Parse JSON → clean summary: content type (twitter|github|youtube|reddit|webpage), title, author (if ∃), content preview (first 500 chars), platform-specific metadata (stars, score, view_count, like_count, upload_date, tags, chapters, transcript, etc.). Show full JSON in `<details>` block.

## Error Handling

- `success: false` → show error, suggest alternatives (WebFetch, manual input)
- Scraper ¬installed → `cd $PLUGIN_ROOT && uv sync --extra all`

$ARGUMENTS
