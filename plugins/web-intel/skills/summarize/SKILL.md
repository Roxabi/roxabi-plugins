---
name: summarize
argument-hint: '<url>'
description: Scrape a URL and produce a concise summary — key points, takeaways, who/what/why. Triggers: "summarize url" | "tldr" | "summarize this" | "summarize https://" | "/summarize" | "give me a summary of" | "what's this article about" | "summarize this link" | "what does this page say".
version: 0.1.0
allowed-tools: Bash, Read
---

# Summarize

Scrape URL → concise, actionable summary.

## Entry

```
/summarize https://example.com
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

## Step 2 — Scrape

```bash
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

## Step 3 — Analyze & Summarize

Produce:
1. **TL;DR** (1-2 sentences) — core message
2. **Key Points** (3-5 bullets) — main ideas, importance-ordered
3. **Who** — author/org + credibility/context
4. **What** — subject matter
5. **Why it matters** — relevance, implications, so-what
6. **Takeaways** (2-3 bullets) — actionable insights

Platform-specific enrichment:

| Platform | Extra fields |
|----------|-------------|
| Twitter/X | Engagement metrics (likes, RTs), thread context |
| GitHub | Stars, language, key README features |
| YouTube | Duration, key timestamps (∃ transcript) |
| Reddit | Score, top comment highlights, community sentiment |

## Step 4 — Present

Output in clean markdown. Include source URL + scrape date.
`success: false` → fall back to WebFetch, summarize from that.

$ARGUMENTS
