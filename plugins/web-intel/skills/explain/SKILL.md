---
name: explain
argument-hint: '<url> [<prompt> | --concept | --digest | --steelman | --compare <url-b>]'
description: 'Scrape a URL and apply a custom prompt or preset analysis — concept explainer, multi-angle digest, argument steelman, or head-to-head compare. Open-ended complement to `analyze-url` (which has a fixed schema). Triggers: "explain url" | "explain this" | "explain https://" | "concept explainer" | "steelman" | "digest url" | "compare urls" | "explain page" | "deep read".'
version: 0.1.0
allowed-tools: Bash, Read
---

# Explain

Scrape URL → apply **user prompt** (or preset) → structured output.

Sits between `summarize` (shallow TL;DR) and `analyze-url` (fixed tech/business schema) — this one is **prompt-driven**, schema flexible.

## Entry

```
/explain https://example.com "What is the core idea and what's novel about it?"
/explain https://example.com --concept
/explain https://example.com --digest
/explain https://example.com --steelman
/explain https://a.com --compare https://b.com
/explain https://example.com                    # → DP(B) for prompt
```

¬ URL → DP(B) for URL.

## Flags

| Flag | Preset prompt |
|---|---|
| `--concept` | "Explain the core concept for an informed but non-expert reader. Structure: TL;DR · key claim · how it works (mechanism) · what's genuinely novel · where it falls apart / open questions." |
| `--digest` | "Produce a multi-angle digest. Sections: Who · What · Why now · How it works · Who benefits · Who loses · What would make this fail · What this unlocks next." |
| `--steelman` | "Build the strongest possible version of the argument, even improving on weak parts. Then list 3 toughest counter-arguments with honest weight." |
| `--compare <url-b>` | "Scrape both URLs. Produce a head-to-head comparison — common ground · true disagreements · false disagreements (same idea, different words) · which is more compelling and why." |

Free-form prompt → used verbatim as extraction instruction.

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

exit 1 → show, stop, guide install. Skip on subsequent invocations.

## Step 2 — Scrape

Single URL:

```bash
cd "$PLUGIN_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

`--compare` ∃ → scrape both URLs; label outputs `A` and `B`.

`success: false` → fall back to `WebFetch` for the failing URL.

## Step 3 — Apply Prompt

Read scraped content. Resolve the prompt:

```
flag ∃      → use preset prompt  (table above)
free-form ∃ → use as-is, verbatim
neither     → DP(B) for prompt
```

**Reasoning rules:**

1. **Ground in source.** Every claim → quote or paraphrase-with-locator (paragraph/section). ¬ invent.
2. **Distinguish** what the source *says* from your *inference*. Prefix inferences with "inferred:" or mark confidence.
3. **Be concrete.** Replace "various benefits" with the actual benefits named.
4. **Name what's missing** — the source's blind spots, unstated assumptions, unresolved tensions.
5. **¬ padding.** If a section has nothing to say, drop it.

## Step 4 — Present

Output structured markdown. Default sections (adapt to preset / prompt):

```markdown
# <page title> — <1-line framing>

> **Source**: <URL>
> **Date**: <YYYY-MM-DD>
> **Prompt**: <preset name or first 80 chars of free-form>

## TL;DR

<2-3 sentences answering the prompt at the highest level>

## <Sections driven by preset / free-form prompt>

...

## Open questions / what the source doesn't answer

- ...

## Confidence

- ★ = verbatim in source
- ◐ = strong inference
- ◯ = speculative / requires external verification
```

**`--compare` output** — replace sections with:

```markdown
## Common ground
## True disagreements
## False disagreements (same idea, different words)
## Verdict — which is more compelling and why
```

## Error Handling

- Both `--compare` URLs fail → stop, show errors
- Scraped content < 200 chars → inform user (likely paywall / JS-only) → suggest `WebFetch` or manual input
- Prompt implies domain expertise the source lacks → answer what's there, flag gap explicitly

## When to use which web-intel skill

| Want | Use |
|---|---|
| Quick TL;DR | `summarize` |
| Fixed tech/biz schema | `analyze-url` |
| Custom question or preset | **`explain`** |
| Steal patterns for your project | `adapt` |
| Critique a site (design/UX/copy) | `roast` |
| Benchmark repo vs site | `benchmark` |

$ARGUMENTS
