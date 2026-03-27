---
name: video-recipe
argument-hint: '<youtube-url> [--compare] [--list] [--html]'
description: 'Analyze a YouTube video to extract narrative structure, VAKOG sensory predicates, and reusable content creation recipes. Triggers: "video-recipe" | "analyze video" | "video recipe" | "content recipe" | "extract recipe".'
version: 0.1.0
allowed-tools: Bash, Read, Write, Glob, ToolSearch, AskUserQuestion
---

# Video Recipe

Analyze a YouTube video → extract narrative structure, VAKOG sensory predicates, content creation techniques, and a reusable recipe.

## Entry

```
/video-recipe https://youtube.com/watch?v=...
/video-recipe https://youtube.com/watch?v=... --html
/video-recipe https://youtube.com/watch?v=... --compare
/video-recipe --list
```

If no URL and no flag provided → `AskUserQuestion` to get a YouTube URL.

## Flags

- `--html` — after markdown output, generate a visual HTML report via `visual-explainer` and upload to gui.new
- `--compare` — after analysis, compare with previously stored analyses in vault
- `--list` — list all stored analyses (no URL needed)

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

On the **first invocation** in this session:

1. Run the doctor check:

```bash
cd "$CONTENT_LAB_ROOT" && uv run python scripts/doctor.py
```

2. If doctor reports core failures (exit code 1) → show output and stop.
3. Skip on subsequent invocations in the same session.

## Step 2 — Handle --list

If `--list` flag is present:

1. Read `~/.roxabi-vault/content-lab/analyses/index.json`
2. Present a table:

```
# | Date       | Channel          | Title                              | VAKOG Signature | Lang
1 | 2026-03-17 | Le SamourAI      | -4800$/client: L'ardoise salée...  | Ad42-K27-V19-A12| fr
```

3. Stop here. No further steps.

## Step 3 — Scrape Video

```bash
cd "$WEB_INTEL_ROOT" && SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt uv run python scripts/scraper.py "$URL"
```

Save the raw JSON output to a temp file for the analyzer.

If `success: false` or no transcript → inform the user and stop.

## Step 4 — Run Analyzer

```bash
cd "$CONTENT_LAB_ROOT" && uv run python scripts/analyze.py /tmp/content-lab-scrape.json
```

This returns structured JSON with:
- `metadata` — title, author, duration, language, segment count
- `vakog` — global distribution, temporal blocks, choreography, signature, examples
- `techniques` — detected content creation patterns with confidence levels

## Step 5 — Interpret and Present (Claude reasoning)

Parse the analyzer JSON. Present the analysis in markdown with these sections:

### Section 1 — Video Card

Table with: title, channel, duration, language, segments count.

### Section 2 — VAKOG Profile

1. **Signature** — the compact code (e.g. `Ad42-K27-V19-A12`)
2. **Archetype name** — give a 2-word name based on the dominant pair:
   - Ad+K = "Analyste visceral"
   - K+V = "Conteur immersif"
   - V+Ad = "Vulgarisateur visuel"
   - Ad+A = "Pedagogue structure"
   - K+A = "Storyteller emotionnel"
   - (use judgment for other combos)
3. **Global distribution** — bar chart in text
4. **Temporal choreography** — table of blocks with dominant system per phase
5. **Pattern** — describe the choreography (e.g. "K→Ad→K sandwich sensoriel")
6. **Interpretation** — explain WHY this pattern works for retention/persuasion:
   - What does the hook system activate (limbique, cortex, etc.)?
   - Why is the body system appropriate for credibility?
   - How do the relances reset attention?
   - What does the close system trigger (urgency, emotion)?
7. **Top examples** — 3-5 best examples per system with timestamp

### Section 3 — Narrative Structure

Analyze the transcript to identify phases:

1. **Hook** — what technique opens the video, how long, what makes it work
2. **Setup** — how the creator sets expectations and promises value
3. **Body** — main argument structure (cases, expansion, synthesis)
4. **Relances** — attention reset moments (visual pivots, new sub-topics)
5. **CTA** — how the call-to-action is integrated (interrupting or narrative?)
6. **Close** — how the video ends, callback to hook?, provocative clip?

Present as a timing table + analysis.

### Section 4 — Techniques Detected

Present each detected technique with:
- Name (FR + EN)
- Confidence (high/medium/low)
- Location in video
- Evidence / example from transcript
- Reusable takeaway (1-sentence recipe)

Add any techniques you identify through reasoning that the script may have missed.

### Section 5 — Reusable Recipe

A synthesis table:

```
| Component    | Pattern                        | When to use            |
|-------------|-------------------------------|------------------------|
| Hook        | K metaphor + stat-shock       | First 10% of video    |
| ...         | ...                           | ...                    |
```

Include the **target VAKOG ratio** for this type of content.

## Step 6 — Store Analysis

Save the analysis to vault for future `--compare` and `--list`:

1. Ensure directory exists: `mkdir -p ~/.roxabi-vault/content-lab/analyses`
2. Write the raw analyzer JSON to `~/.roxabi-vault/content-lab/analyses/YYYY-MM-DD_<slug>.json`
   - Slug: lowercase channel + title keywords, max 50 chars, hyphens
3. Update `~/.roxabi-vault/content-lab/analyses/index.json`:
   - Append entry: `{date, channel, title, url, signature, language, file}`
   - Create the file if it does not exist

## Step 7 — Handle --compare

If `--compare` flag is present:

1. Read all previous analyses from index.json
2. For each previous analysis, compare:
   - VAKOG signature delta (shift in percentages)
   - Shared vs unique techniques
   - Choreography pattern similarity
3. Present a comparison table:
   - Which patterns are universal (appear in all videos)?
   - Which are specific to this creator?
   - What is the "meta-recipe" emerging from the corpus?

## Step 8 — Handle --html

If `--html` flag is present:

1. Invoke the `visual-explainer` skill with the full analysis markdown as input
2. Request a self-contained HTML page with:
   - VAKOG bar charts and temporal heatmap
   - Narrative structure timeline
   - Technique cards
3. Upload to gui.new and share the URL

## Error Handling

- If scraper fails → suggest checking the URL or trying `WebFetch` as fallback
- If no transcript → inform user this video has no captions available
- If analyzer fails → show raw error, suggest running doctor check

$ARGUMENTS
