---
name: roast
argument-hint: '<url>'
description: Brutally honest critique of a website — design, UX, copy, performance, a11y. Triggers: "roast" | "critique site" | "roast this site".
version: 0.1.0
allowed-tools: Bash, Read
---

# Roast

Scrape + screenshot a website → deliver a brutally honest, constructive critique.

## Entry

```
/roast https://example.com
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

## Step 2 — Scrape Content

```bash
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

## Step 3 — Screenshot (Optional)

If `agent-browser` is available:

```bash
agent-browser open "$URL"
agent-browser wait --load networkidle
agent-browser screenshot --full /tmp/roast-screenshot.png
agent-browser snapshot -i
```

If unavailable → skip visual capture, note in output.

## Step 4 — The Roast

Analyze the site across these dimensions. Be **direct and specific** — no "it could be improved." Say exactly what's wrong and how to fix it.

### Dimensions

1. **First Impression** (5 seconds) — What hits you immediately? Confusion? Clarity? "WTF is this?"
2. **Design & Visual** — Layout, typography, color, whitespace, consistency. Does it look professional or like a 2015 template?
3. **UX & Navigation** — Can you figure out what this does in 10 seconds? Is the CTA obvious? Mobile-friendly?
4. **Copy & Messaging** — Is the value prop clear? Buzzword soup? Does it speak to real problems?
5. **Performance Signals** — Heavy page? Slow loads? Bloated assets?
6. **Accessibility** — Semantic HTML? Contrast? Keyboard navigation? Alt text?
7. **Trust Signals** — Social proof? Pricing transparency? Professional domain?
8. **Technical** — Modern stack? SEO basics? Open Graph? Structured data?

### Scoring

Rate each dimension: 🔥 (fire/great) | 👍 (solid) | 😐 (meh) | 👎 (needs work) | 💀 (oof)

### Overall Verdict

End with:
- **Overall Grade**: A-F
- **Top 3 Fixes** — highest-impact changes they should make NOW
- **What They Got Right** — at least 1-2 genuinely positive things

## Tone

Honest but constructive. Think "senior designer peer review" not "internet troll." Every critique includes a specific fix suggestion.

$ARGUMENTS
