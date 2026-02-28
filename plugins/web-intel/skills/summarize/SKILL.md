---
name: summarize
argument-hint: '<url>'
description: Scrape a URL and produce a concise summary — key points, takeaways, who/what/why. Triggers: "summarize url" | "tldr" | "summarize this".
allowed-tools: Bash, Read
---

# Summarize

Scrape a URL → produce a concise, actionable summary.

## Entry

```
/summarize https://example.com
```

If no URL provided → `AskUserQuestion` to get one.

## Step 1 — Scrape

```bash
PLUGIN_ROOT=$(find ~/projects -maxdepth 4 -path "*/web-intel/pyproject.toml" -print -quit 2>/dev/null | xargs dirname)
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

## Step 2 — Analyze & Summarize

From the scraped content, produce:

### Summary Structure

1. **TL;DR** (1-2 sentences) — the core message
2. **Key Points** (3-5 bullets) — main ideas, ordered by importance
3. **Who** — author/org and their credibility/context
4. **What** — the subject matter
5. **Why it matters** — relevance, implications, so-what
6. **Takeaways** (2-3 bullets) — actionable insights or things to remember

### Platform-Specific Enrichment

- **Twitter/X**: Include engagement metrics (likes, RTs), thread context if applicable
- **GitHub**: Include stars, language, key features from README
- **YouTube**: Include duration, key timestamps if transcript available
- **Reddit**: Include score, top comment highlights, community sentiment

## Step 3 — Present

Output the summary in clean markdown. Include source URL and scrape date at the bottom.

If `success: false` → fall back to `WebFetch` tool and summarize from that.

$ARGUMENTS
