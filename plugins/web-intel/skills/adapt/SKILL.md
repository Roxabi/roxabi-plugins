---
name: adapt
argument-hint: '<url>'
description: Extract what works from a URL and suggest how to adapt patterns/copy/design for your project. Triggers: "adapt" | "inspire from" | "steal from" | "adapt this".
version: 0.1.0
allowed-tools: Bash, Read, AskUserQuestion
---

# Adapt

Scrape a URL → extract what works → suggest how to adapt patterns, copy, and design for your project.

## Entry

```
/adapt https://example.com
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

## Step 3 — Extract What Works

Analyze the scraped content to identify reusable patterns:

### Content & Copy
- **Headlines & CTAs** — effective copy patterns, power words, structure
- **Value Propositions** — how they frame their product/service
- **Social Proof** — how they build trust (testimonials, logos, metrics)
- **Microcopy** — button text, error messages, onboarding flows

### Design Patterns
- **Layout** — page structure, section ordering, visual hierarchy
- **Navigation** — menu structure, breadcrumbs, search UX
- **Component Patterns** — cards, pricing tables, feature grids, hero sections
- **Color & Typography** — palette choices, font pairing, heading scale

### Technical Patterns
- **Architecture** — SSR/SPA, API patterns, auth flows
- **Performance** — lazy loading, caching strategies, CDN usage
- **Integrations** — analytics, payment, auth providers
- **Developer Experience** — docs structure, API design, SDK patterns

### Business Patterns
- **Pricing Structure** — tiers, free plan, enterprise
- **Growth Mechanics** — referral, viral loops, community
- **Onboarding** — signup flow, activation steps, first value

## Step 4 — Adaptation Recommendations

For each identified pattern, provide:

1. **What they do** — describe the pattern concretely
2. **Why it works** — the principle behind it
3. **How to adapt** — specific suggestion for YOUR project (not a copy, an adaptation)
4. **Implementation effort** — S (hours) / M (days) / L (weeks)
5. **Impact estimate** — High / Medium / Low

### Priority Matrix

Sort recommendations into:
- **Quick wins** (low effort, high impact) — do these first
- **Strategic bets** (high effort, high impact) — plan for these
- **Nice to have** (low effort, low impact) — do if time permits
- **Skip** (high effort, low impact) — not worth it

## Step 5 — Present

Output structured markdown. End with `AskUserQuestion`:
- Implement a specific adaptation? → hand off to appropriate skill
- Deep-dive a specific pattern? → provide more detail
- Adapt from another URL? → loop back

$ARGUMENTS
