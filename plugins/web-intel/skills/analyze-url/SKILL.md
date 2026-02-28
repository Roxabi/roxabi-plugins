---
name: analyze-url
argument-hint: '<url>'
description: Deep analysis of a URL — tech stack, architecture, business model, competitive positioning. Triggers: "analyze url" | "deep dive url" | "analyze this site".
version: 0.1.0
allowed-tools: Bash, Read
---

# Analyze URL

Scrape a URL → deep technical and strategic analysis.

## Entry

```
/analyze-url https://example.com
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

## First Use

On the **first invocation** of any web-intel skill in this session:

1. Run the doctor check:

```bash
cd "$PLUGIN_ROOT" && uv run python scripts/doctor.py
```

2. If doctor reports core failures (exit code 1) → show output to the user and stop. Guide them through the install commands listed in the report.
3. If doctor reports optional warnings → inform the user which platforms have limited support, then continue.
4. Skip this check on subsequent invocations in the same session.

## Step 2 — Scrape

```bash
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

## Step 3 — Deep Analysis

From the scraped content, analyze across these dimensions:

### For SaaS / Product URLs

1. **Product Overview** — what it does, target audience, value prop
2. **Tech Stack Signals** — frameworks, infrastructure, CDN, APIs visible in source/content
3. **Architecture Patterns** — SPA vs SSR, API-first, microservices signals
4. **Business Model** — pricing, freemium, enterprise, self-serve
5. **Competitive Positioning** — market category, differentiation, moat
6. **Growth Signals** — community size, hiring, funding, integrations
7. **Strengths** — what they do well (3-5 bullets)
8. **Weaknesses** — gaps or risks (3-5 bullets)

### For GitHub Repos

1. **Project Health** — stars, forks, recent activity, contributor count
2. **Architecture** — language, framework, project structure
3. **Code Quality Signals** — CI/CD, tests, linting, type safety
4. **Documentation** — README quality, docs site, examples
5. **Community** — issues, PRs, discussions activity
6. **Notable Patterns** — interesting technical choices worth adopting

### For Articles / Content

1. **Thesis** — main argument or claim
2. **Evidence Quality** — data, sources, methodology
3. **Implications** — what this means for the field
4. **Counter-arguments** — what the author missed or glossed over
5. **Actionable Insights** — what to do with this information

## Step 4 — Present

Output structured analysis in markdown with clear headers. Include confidence level (high/medium/low) for inferred information.

If `success: false` → fall back to `WebFetch` tool.

$ARGUMENTS
