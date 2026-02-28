---
name: scrape
argument-hint: '<url>'
description: Extract structured content from a URL — Twitter/X, GitHub, YouTube, Reddit, or any webpage. Triggers: "scrape" | "fetch url" | "extract content".
version: 0.1.0
allowed-tools: Bash, Read
---

# Scrape

Extract structured content from a URL. Returns JSON with content, metadata, and platform-specific fields.

## Entry

```
/scrape https://example.com
```

If no URL provided → `AskUserQuestion` to get one.

## Step 1 — Locate Plugin

```bash
PLUGIN_ROOT=$(find ~/projects -maxdepth 4 -path "*/web-intel/pyproject.toml" -print -quit 2>/dev/null | xargs dirname)
if [ -z "$PLUGIN_ROOT" ]; then
  echo "ERROR: web-intel plugin not found. Install: claude plugin install web-intel"
  exit 1
fi
```

## Step 2 — Run Scraper

```bash
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

## Step 3 — Present Results

Parse the JSON output. Present a clean summary:

- **Content type**: twitter | github | youtube | reddit | webpage
- **Title**: page/post/repo title
- **Author**: if available
- **Content preview**: first 500 chars of extracted text
- **Metadata**: platform-specific fields (stars, score, transcript, etc.)

Show the full JSON in a `<details>` block for reference.

## Error Handling

- If `success: false` → show the error message and suggest alternatives (WebFetch, manual input)
- If scraper not installed → show install instructions: `cd $PLUGIN_ROOT && uv sync --extra all`

$ARGUMENTS
