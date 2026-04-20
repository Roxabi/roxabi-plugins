---
name: voice-style
argument-hint: '<url-or-transcript-path> [--list]'
description: 'Extract a creator''s writing-style card from a transcript — register, fillers, FR/EN code-switching, sentence shape, signature tics, analogy style. Input: YouTube URL or transcript file. Triggers: "voice style" | "writing style" | "style card" | "creator tone" | "tone extract" | "extract style" | "style signature".'
version: 0.1.0
allowed-tools: Bash, Read, Write, Glob
---

# Voice Style

Let:
  α := `~/.roxabi-vault/content-lab/voice-styles`
  T := transcript (text)
  Σ := style card output

Extract *how* a creator speaks from a transcript — compact "voice print" usable to author new copy that sounds like them.

Complements `video-recipe` (narrative arc) and `video-analyze` (on-screen visuals). This one reads **words**.

## Entry

```
/voice-style https://youtube.com/watch?v=...        # scrape + extract
/voice-style ./transcript.md                        # local transcript
/voice-style ~/.roxabi/forge/qaya-analysis/transcript.md
/voice-style --list                                 # browse stored cards
```

¬ arg → DP(B) for URL or path.

## Flags

| Flag | Action |
|------|--------|
| `--list` | List stored style cards (no input needed) |

## Step 1 — Locate Plugins

```bash
CONTENT_LAB_ROOT=$(find ~/projects -maxdepth 4 -path "*/content-lab/pyproject.toml" -print -quit 2>/dev/null | xargs dirname)
WEB_INTEL_ROOT=$(find ~/projects -maxdepth 4 -path "*/web-intel/pyproject.toml" -print -quit 2>/dev/null | xargs dirname)
if [ -z "$CONTENT_LAB_ROOT" ]; then
  echo "ERROR: content-lab plugin not found"
  exit 1
fi
```

## Step 2 — Handle `--list`

`--list` ∃ → `ls -1 α/*.md 2>/dev/null` → present table (date · creator · language · signature line). Stop.

## Step 3 — Acquire Transcript

```
input ∈ URL  → scrape (needs WEB_INTEL_ROOT)
input ∈ path → read file
```

**URL path:**

```bash
TMPDIR=$(mktemp -d -t "voice-style-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
SCRAPE="$TMPDIR/scrape.json"
cd "$WEB_INTEL_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL" > "$SCRAPE"
# Transcript field name varies by platform; try .transcript, .content.transcript, .body
T=$(jq -r '.transcript // .content.transcript // .body // empty' "$SCRAPE")
```

¬ T (empty transcript) → inform user captions/transcript unavailable → stop.

**File path:** read directly.

Trim T to first 12000 chars if longer (context budget). Note truncation in the card footer.

## Step 4 — Extract Style Card

Read T and produce Σ with the **exact schema below**. Reason from textual evidence — quote short phrases from T as proof points. ¬ invent — mark `n/a` if signal absent.

### Σ schema

```markdown
# Voice Style — <Creator / Source title>

> **Source**: <URL or file path>
> **Date**: <YYYY-MM-DD>
> **Language**: <primary> (+ <secondary> if code-switching)
> **Transcript length**: <chars> chars (<minutes> min approx)

## Signature

**One sentence:** <creator>'s voice is <2-3 adjectives> — <core move in 10 words>.

## Register

- **Level**: casual | semi-casual | neutral | formal
- **Distance**: friend-to-friend | teacher-to-student | pitch | lecture
- **Evidence**: "<phrase from T>" · "<phrase from T>"

## Filler lexicon

Top fillers / connectors (with raw count if stats ran):

| Filler | Count (approx) | Function |
|---|---|---|
| `en gros` | 14 | approximation / reset |
| `du coup` | 9 | causal bridge |
| `globalement` | 6 | summarization |
| `meuf` | 4 | address / familiarity |

## Code-switching (if multilingual)

- **Base**: <fr|en|...>
- **Switch triggers**: tech terms · jargon · anglicisms · product names
- **Ratio**: <rough %> of non-base-language tokens
- **Examples**: "scale-up", "track record", "package", "smart"

## Sentence shape

- **Length**: short-punchy | medium | long-winding | mixed
- **Rhythm**: <2-3 word description — e.g. "staccato + breath">
- **Pattern**: <e.g. "claim · example · one-word beat">
- **Evidence**: "<short quote>"

## Tone & posture

- **Emotional baseline**: confident | warm | urgent | contemplative | sardonic
- **Vs audience**: assertive | collaborative | deferential | challenging
- **Evidence**: "<phrase>"

## Signature moves

Rhetorical tics / repeated patterns (2-5 items):

- **<move name>**: <what it looks like> — ex: "<quote>"
- **<move name>**: ...

## Analogy style

- **Frequency**: high | medium | low | rare
- **Sources**: kitchen | sports | war | gaming | daily-life | tech-internal | none
- **Pattern**: <e.g. "abstract → 1-line concrete analogy → return to abstract">
- **Best example**: "<quote>"

## Do / Don't (for mimicking this voice)

| Do | Don't |
|---|---|
| Open with a concrete image | Start with a 3-clause intro |
| Use `<signature filler>` to reset | Over-explain abstractions |
| ... | ... |

## Footer

- **Confidence**: ★ = ≥3 instances in T · ◐ = 1-2 instances · ◯ = inferred
- **Truncation**: <none | first 12k chars only>
```

### Guidance for extraction

1. **Count actual occurrences** when possible — grep T for candidate fillers. Report approximate counts, not exact.
2. **Quote verbatim** — no paraphrase in evidence lines.
3. **Prefer specific over generic** — "staccato + breath" > "punchy". Name the move.
4. **Distinguish filler vs genuine content-word** — `du coup` at sentence head = filler; mid-clause = causal.
5. **Code-switching:** if single language, omit section entirely (do not output `n/a` block).
6. **Length target:** ~40-80 lines total. Tight.

## Step 5 — Store + Present

```bash
mkdir -p α
SLUG=$(echo "<creator or source>" | tr '[:upper:] ' '[:lower:]-' | sed 's/[^a-z0-9-]//g' | cut -c1-50)
OUT="$α/$(date +%Y-%m-%d)_${SLUG}.md"
```

Write Σ → `$OUT`. Echo path. Render Σ inline to the user.

## Error Handling

- Scraper returns `success: false` → fall back to asking user for transcript path
- Transcript < 500 chars → inform user too short for reliable extraction, stop
- Multiple speakers in T → note it in footer, extract dominant speaker only (first-person lines + longest runs)

## Notes

- Not for **brand voice** (collective/organizational tone) — use external `brand-voice:*` skills instead
- Not for **narrative structure** (arc / hooks / techniques) — use `video-recipe`
- Card output feeds VIDEO-VOICE-PLAYBOOK Phase 5 script enforcement — keep the schema stable

$ARGUMENTS
