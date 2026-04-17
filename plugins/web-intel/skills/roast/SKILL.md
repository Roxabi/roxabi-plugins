---
name: roast
argument-hint: '<url>'
description: Brutally honest critique of a website — design, UX, copy, performance, a11y. Triggers: "roast" | "critique site" | "roast this site" | "roast https://" | "tear apart this website" | "honest critique" | "what's wrong with this site" | "rip apart" | "brutal feedback on this site".
version: 0.1.0
allowed-tools: Bash, Read
---

# Roast

Let:
  U := target URL
  PR := `$PLUGIN_ROOT`
  AB := agent-browser (preferred — adds `snapshot -i` for interactive refs)
  PW := `uv run python scripts/screenshot.py` (fallback — reuses web-intel's Playwright extra)

Scrape + screenshot U → deliver brutally honest, constructive critique.

## Entry

```
/roast https://example.com
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

## Step 3 — Screenshot

Tempfile per `${CLAUDE_PLUGIN_ROOT}/../shared/references/tempfile-convention.md`:

```bash
TMPDIR=$(mktemp -d -t "web-intel-roast-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
SHOT="$TMPDIR/screenshot.png"
```

∃ AB:

```bash
agent-browser open "$URL" && \
agent-browser wait --load networkidle && \
agent-browser screenshot --full "$SHOT" && \
agent-browser snapshot -i
```

¬∃ AB → PW fallback (web-intel already ships Playwright):

```bash
cd "$PLUGIN_ROOT" && uv run python scripts/screenshot.py "$URL" "$SHOT"
```

Neither available → skip, note in output.

## Step 4 — The Roast

Be **direct and specific** — no "it could be improved." State exactly what's wrong and how to fix it.

| # | Dimension | What to assess |
|---|-----------|----------------|
| 1 | **First Impression** | 5-second hit — confusion? clarity? "WTF is this?" |
| 2 | **Design & Visual** | Layout, typography, color, whitespace, consistency |
| 3 | **UX & Navigation** | Understandable in 10s? CTA obvious? Mobile-friendly? |
| 4 | **Copy & Messaging** | Value prop clear? Buzzword soup? Real problems? |
| 5 | **Performance** | Heavy page? Slow loads? Bloated assets? |
| 6 | **Accessibility** | Semantic HTML, contrast, keyboard nav, alt text |
| 7 | **Trust Signals** | Social proof, pricing transparency, pro domain |
| 8 | **Technical** | Modern stack, SEO basics, Open Graph, structured data |

Rate each: 🔥 great | 👍 solid | 😐 meh | 👎 needs work | 💀 oof

**Overall Verdict:** Grade A–F + Top 3 Fixes (highest-impact, do NOW) + ≥1 genuine positive.

**Tone:** Senior designer peer review — ¬internet troll. ∀ critique → specific fix.

$ARGUMENTS
