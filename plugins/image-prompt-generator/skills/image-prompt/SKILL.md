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

## Phase 2 — Accept Concept

1. If no concept provided via $ARGUMENTS, AskUserQuestion:
   - "Describe the image you want to generate. Include subject, context, and any specific requirements."
2. Parse the concept into components:
   - **Subject** — the main focus of the image
   - **Context** — setting, environment, background
   - **Intent** — what the image is for (social media, presentation, website, etc.)
   - **Constraints** — aspect ratio, platform requirements, style preferences

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

Generate 4-6 prompt variants across different styles. Each variant must include:

| Component | Description |
|-----------|-------------|
| **Style** | Artistic style from references (e.g., "cinematic photography", "flat illustration") |
| **Subject** | Detailed subject description with attributes |
| **Composition** | Framing, perspective, focal point |
| **Lighting** | Light source, quality, mood |
| **Color palette** | Dominant colors, harmony type |
| **Mood** | Emotional tone, atmosphere |
| **Technical** | Resolution, aspect ratio, rendering details |

Variant distribution:
- 1-2 photographic styles
- 1-2 illustration/digital art styles
- 1 stylized/artistic style
- 1 experimental/unexpected style

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
