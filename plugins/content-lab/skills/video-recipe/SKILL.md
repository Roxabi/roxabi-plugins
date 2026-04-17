---
name: video-recipe
argument-hint: '<youtube-url> [--compare] [--list] [--html]'
description: 'Analyze a YouTube video to extract narrative structure, VAKOG sensory predicates, and reusable content creation recipes. Triggers: "video-recipe" | "analyze video" | "video recipe" | "content recipe" | "extract recipe".'
version: 0.1.0
allowed-tools: Bash, Read, Write, Glob, ToolSearch
---

# Video Recipe

Let:
  α := `~/.roxabi-vault/content-lab/analyses`
  Ω := analyzer JSON output

Analyze a YouTube video → extract narrative structure, VAKOG sensory predicates, content creation techniques, and a reusable recipe.

## Entry

```
/video-recipe https://youtube.com/watch?v=...
/video-recipe https://youtube.com/watch?v=... --html
/video-recipe https://youtube.com/watch?v=... --compare
/video-recipe --list
```

URL ∄ ∧ flag ∄ → → DP(B)for YouTube URL.

## Flags

| Flag | Action |
|------|--------|
| `--html` | After markdown output, generate visual HTML via `visual-explainer`, upload to gui.new |
| `--compare` | After analysis, compare with stored analyses in vault |
| `--list` | List all stored analyses (no URL needed) |

## Step 1 — Locate Plugins

```bash
WEB_INTEL_ROOT=$(find ~/projects -maxdepth 4 -path "*/web-intel/pyproject.toml" -print -quit 2>/dev/null | xargs dirname)
CONTENT_LAB_ROOT=$(find ~/projects -maxdepth 4 -path "*/content-lab/pyproject.toml" -print -quit 2>/dev/null | xargs dirname)
if [ -z "$WEB_INTEL_ROOT" ] || [ -z "$CONTENT_LAB_ROOT" ]; then
  echo "ERROR: Required plugins not found."
  exit 1
fi
```

## First Use

First invocation in session only:

```bash
cd "$CONTENT_LAB_ROOT" && uv run python scripts/doctor.py
```

Doctor exit 1 → show output and stop. Skip on subsequent invocations.

## Step 2 — Handle --list

`--list` ∃ → read `α/index.json` → present table:

```
# | Date       | Channel          | Title                              | VAKOG Signature | Lang
1 | 2026-03-17 | Le SamourAI      | -4800$/client: L'ardoise salée...  | Ad42-K27-V19-A12| fr
```

Stop here.

## Step 3 — Scrape Video

Tempfile per `${CLAUDE_PLUGIN_ROOT}/../shared/references/tempfile-convention.md`:

```bash
TMPDIR=$(mktemp -d -t "content-lab-scrape-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
SCRAPE="$TMPDIR/scrape.json"
cd "$WEB_INTEL_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL" > "$SCRAPE"
```

Save raw JSON to `"$SCRAPE"`. `success: false` ∨ no transcript → inform user and stop.

## Step 4 — Run Analyzer

```bash
cd "$CONTENT_LAB_ROOT" && uv run python scripts/analyze.py "$SCRAPE"
```

Ω contains: `metadata` (title, author, duration, language, segment count) | `vakog` (distribution, temporal blocks, choreography, signature, examples) | `techniques` (detected patterns with confidence).

## Step 5 — Interpret and Present

Parse Ω → present in markdown:

### Section 1 — Video Card
Table: title, channel, duration, language, segment count.

### Section 2 — VAKOG Profile

1. **Signature** — compact code (e.g. `Ad42-K27-V19-A12`)
2. **Archetype** — 2-word name from dominant pair:

| Pair | Name |
|------|------|
| Ad+K | Analyste visceral |
| K+V | Conteur immersif |
| V+Ad | Vulgarisateur visuel |
| Ad+A | Pedagogue structure |
| K+A | Storyteller emotionnel |

3. **Global distribution** — text bar chart
4. **Temporal choreography** — table of blocks with dominant system per phase
5. **Pattern** — describe choreography (e.g. "K→Ad→K sandwich sensoriel")
6. **Interpretation** — WHY the pattern works: hook system (limbique/cortex), body credibility, relances attention reset, close trigger
7. **Top examples** — 3-5 best per system with timestamp

### Section 3 — Narrative Structure

Analyze transcript: Hook | Setup | Body | Relances | CTA | Close. Present as timing table + analysis.

### Section 4 — Techniques Detected

∀ technique: Name (FR+EN) | Confidence | Location | Evidence | 1-sentence reusable takeaway. Add techniques identified via reasoning.

### Section 5 — Reusable Recipe

```
| Component    | Pattern                        | When to use            |
|-------------|-------------------------------|------------------------|
| Hook        | K metaphor + stat-shock       | First 10% of video    |
| ...         | ...                           | ...                    |
```

Include **target VAKOG ratio** for this content type.

## Step 6 — Store Analysis

1. `mkdir -p α`
2. Write raw Ω → `α/YYYY-MM-DD_<slug>.json` (slug: lowercase channel+title, max 50 chars, hyphens)
3. Update `α/index.json` — append `{date, channel, title, url, signature, language, file}`, create if ∄

## Step 7 — Handle --compare

`--compare` ∃: read all entries from index.json → ∀ previous: compare VAKOG delta, shared vs unique techniques, choreography similarity → table: universal patterns | creator-specific | meta-recipe.

## Step 8 — Handle --html

`--html` ∃: invoke `visual-explainer` with full analysis markdown → self-contained HTML (VAKOG charts + temporal heatmap, narrative timeline, technique cards) → upload to gui.new → share URL.

## Error Handling

- Scraper fails → suggest checking URL or `WebFetch` fallback
- No transcript → inform user captions unavailable
- Analyzer fails → show raw error, suggest doctor check

$ARGUMENTS
