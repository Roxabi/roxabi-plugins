---
name: image-prompt
description: 'Generate AI image prompts with visual identity and style consistency — reads brand charter, applies artistic styles, outputs multiple prompt variants. Triggers: "image-prompt" | "generate image prompt" | "image prompt" | "prompt for image" | "visual prompt".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---

# Image Prompt Generator

**Goal:** Transform a concept into multiple ready-to-use image generation prompts, optionally aligned to a brand visual charter.

## Phase 1 — Load Visual Charter

1. Check for visual charter at `~/.roxabi-vault/config/visual-charter.json`:

```bash
charter="$HOME/.roxabi-vault/config/visual-charter.json"
if [ -f "$charter" ]; then
  echo "CHARTER_FOUND: $charter"
  cat "$charter"
else
  echo "NO_CHARTER — using defaults (no brand constraints)"
fi
```

2. If charter exists, parse brand identity: colors, style preferences, mood, avoidances.
3. If absent, proceed without brand constraints — inform user they can create one from the example at `examples/visual-charter.example.json`.
4. Check for face reference at `~/.roxabi-vault/config/face-reference.json` and load if present.

## Phase 2 — Accept Concept & Intake

1. If no concept provided via $ARGUMENTS, AskUserQuestion:
   - "What image do you want to create? Describe the subject, context, and any specific requirements."

2. Ask structured follow-up questions (one message, all at once):
   - **Platform** — "Where will this image be used?" (Instagram, LinkedIn, website, presentation, thumbnail, other)
   - **Content type** — "What kind of content?" (personal brand, product, educational, promotional, lifestyle, other)
   - **Mood/tone** — "What feeling should it convey?" (professional, warm, dramatic, energetic, minimal, mysterious, other)
   - **Style preference** — "Any style direction?" (photographic, illustrated, 3D, no preference — optional override)
   - **Aspect ratio** — "What format?" (square 1:1, portrait 4:5 or 9:16, landscape 16:9, no preference)

3. Parse all answers into a creative brief:
   - **Subject** — main focus of the image
   - **Context** — setting, environment, background
   - **Platform** — target platform (drives aspect ratio and style decisions)
   - **Content type** — purpose of the image
   - **Mood** — emotional tone and atmosphere
   - **Style** — preferred visual direction (or "open" if no preference)
   - **Aspect ratio** — target format

4. AskUserQuestion: "Do you want your face/likeness to appear in the image? (yes/no)"
   - If yes → proceed to Phase 2.5
   - If no → skip to Phase 2.75

## Phase 2.5 — Face Reference Resolution

Only execute if user confirmed they want their face in the image.

1. If `face-reference.json` was found in Phase 1, display a summary and confirm:
   - "Using your saved face reference: [description]. Is this still accurate? (yes/update)"
   - If update → ask for new description and overwrite the file
2. If not found, ask the user:
   - "Please describe your appearance for the prompt (e.g. hair color and style, eye color, age range, skin tone, any distinctive features)."
3. Save to vault for future sessions:

```bash
mkdir -p "$HOME/.roxabi-vault/config"
cat > "$HOME/.roxabi-vault/config/face-reference.json" << EOF
{
  "description": "FACE_DESCRIPTION",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
```

4. Store the face description as `FACE_DESC` — it will be injected into the Subject component of every prompt variant in Phase 4.

## Phase 2.75 — Vault Search (Optional)

Check if vault has relevant ideas, notes, or references that could enrich the image concept:

```bash
python3 -c "
import sys
sys.path.insert(0, '$CLAUDE_PLUGIN_ROOT/../..')
from roxabi_sdk.paths import vault_healthy
print('VAULT_OK' if vault_healthy() else 'VAULT_UNAVAILABLE')
" 2>/dev/null || echo "VAULT_UNAVAILABLE"
```

If vault is healthy, search for related content using the concept keywords:

```bash
python3 -c "
import sqlite3, json
from pathlib import Path
home = Path.home() / '.roxabi-vault'
conn = sqlite3.connect(str(home / 'vault.db'))
rows = conn.execute(
    'SELECT title, substr(content, 1, 200) FROM entries WHERE category IN (\"ideas\", \"content\", \"references\") ORDER BY created_at DESC LIMIT 5'
).fetchall()
conn.close()
for r in rows: print(json.dumps({'title': r[0], 'preview': r[1]}))
" 2>/dev/null
```

- If relevant entries found: surface them and incorporate key themes, mood, or context into the creative brief
- If vault unavailable or no relevant results: skip silently — proceed to Phase 3

## Phase 3 — Load Style References

1. Read reference files for style guidance:

```bash
echo "=== Loading references ==="
plugin_dir=$(dirname "$(dirname "$(dirname "$0")")")
for ref in references/artistic_styles.md references/prompt_best_practices.md; do
  if [ -f "$ref" ]; then
    echo "LOADED: $ref"
  fi
done
```

2. Read `references/artistic_styles.md` for available styles.
3. Read `references/prompt_best_practices.md` for prompt structure and platform tips.

## Phase 4 — Generate Prompt Variants

Generate 4-6 prompt variants informed by the creative brief from Phase 2. Each variant must include:

| Component | Description |
|-----------|-------------|
| **Style** | Artistic style from references — if user specified a style preference, lead with that; otherwise distribute across categories |
| **Subject** | Detailed subject description — if `FACE_DESC` is set, prepend it: "[FACE_DESC], [rest of subject]" |
| **Composition** | Framing and perspective matched to the target aspect ratio from the brief |
| **Lighting** | Light source and quality matched to the mood from the brief |
| **Color palette** | Dominant colors and harmony — informed by brand charter if present |
| **Mood** | Emotional tone matched to the mood/tone answer from the brief |
| **Technical** | Resolution, aspect ratio (from brief), platform-specific rendering details |

Variant distribution — adapt based on style preference:
- If style preference given: 2-3 variants in that direction + 1-2 creative divergences
- If no preference: 1-2 photographic, 1-2 illustration/digital art, 1 stylized, 1 experimental

Use vault content (if found in Phase 2.75) to add contextual depth to subject descriptions and mood.

## Phase 5 — Apply Brand Identity

If charter exists, apply brand constraints to each variant:

1. **Colors** — incorporate brand palette (primary, secondary, accent)
2. **Style alignment** — match brand aesthetic and mood
3. **Avoidances** — exclude anything in the brand's avoid list
4. **Preferences** — emphasize items in the brand's prefer list

Mark each variant as:
- **On-brand** — fully aligned with charter
- **Near-brand** — partially aligned, creative interpretation
- **Off-brand** — deliberately divergent (for exploration)

## Phase 6 — Present Variants

Auto-save all variants to vault before presenting:

```bash
save_dir="$HOME/.roxabi-vault/image-prompts"
mkdir -p "$save_dir"
timestamp=$(date +%Y-%m-%d-%H-%M-%S)
save_file="$save_dir/$timestamp.md"
# Write concept, face reference (if used), and all variants to the file
echo "# Image Prompts — $timestamp" > "$save_file"
echo "Concept: USER_CONCEPT" >> "$save_file"
# Append each variant block
echo "Saved to: $save_file"
```

Present all variants in a structured format:

```
Variant 1 — [Style Name] [Brand Alignment]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt: [full prompt text ready to copy]

Style: [style category]
Composition: [framing details]
Lighting: [lighting description]
Mood: [atmosphere]
Best for: [recommended platform/use case]
```

AskUserQuestion:
- **Pick one** — select a variant number to use
- **Refine** — pick a variant and request changes
- **Regenerate** — try again with different styles
- **Batch** — run generate_prompt_variants.py for more variants

## Phase 7 — Batch Generation (Optional)

If user requests batch generation, run the Python script:

```bash
python3 scripts/generate_prompt_variants.py \
  --concept "user concept here" \
  --charter "$HOME/.roxabi-vault/config/visual-charter.json" 2>/dev/null || \
python3 scripts/generate_prompt_variants.py \
  --concept "user concept here"
```

Present batch results for selection.

$ARGUMENTS
