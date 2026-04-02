---
name: adapt
argument-hint: '<url>'
description: Extract what works from a URL and suggest how to adapt patterns/copy/design for your project. Triggers: "adapt" | "inspire from" | "steal from" | "adapt this".
version: 0.1.0
allowed-tools: Bash, Read
---

# Adapt

Let:
  P(x) := pattern of type x (content | design | technical | business)

Scrape URL → extract what works → suggest adaptations for your project.

## Entry

```
/adapt https://example.com
```

¬U → `AskUserQuestion` to get one.

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

## Step 3 — Extract What Works

Identify reusable patterns across 4 domains:

| Domain | Patterns to extract |
|--------|-------------------|
| **Content & Copy** | Headlines/CTAs, value props, social proof, microcopy |
| **Design** | Layout/section order, nav UX, component patterns, color/typography |
| **Technical** | Architecture (SSR/SPA/API), performance strategies, integrations, DX |
| **Business** | Pricing tiers, growth mechanics, onboarding/activation flow |

## Step 4 — Adaptation Recommendations

∀ identified pattern → provide:
1. What they do (concrete description)
2. Why it works (underlying principle)
3. How to adapt → specific suggestion for YOUR project (¬copy, adaptation)
4. Effort: S (hours) | M (days) | L (weeks)
5. Impact: High | Medium | Low

Sort into priority matrix:
- **Quick wins** (low effort ∧ high impact) — do first
- **Strategic bets** (high effort ∧ high impact) — plan
- **Nice to have** (low effort ∧ low impact) — if time permits
- **Skip** (high effort ∧ low impact) — ¬worth it

## Step 5 — Present

Output structured markdown. `AskUserQuestion`: Implement a specific adaptation? | Deep-dive a pattern? | Adapt from another URL?

$ARGUMENTS
