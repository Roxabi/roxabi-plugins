---
name: image-prompt
description: 'Generate AI image prompts with visual identity and style consistency — reads brand charter, applies artistic styles, outputs multiple prompt variants. Triggers: "image-prompt" | "generate image prompt" | "image prompt" | "prompt for image" | "visual prompt".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---

# Image Prompt Generator

Let:
  χ := `~/.roxabi-vault/config/visual-charter.json`
  φ := `~/.roxabi-vault/config/face-reference.json`
  FACE_DESC := face description (set in Phase 2.5 if user wants their face in image)

**Goal:** Transform a concept into multiple ready-to-use image generation prompts, optionally aligned to a brand visual charter.

## Phase 1 — Load Visual Charter

```bash
charter="$HOME/.roxabi-vault/config/visual-charter.json"
if [ -f "$charter" ]; then
  echo "CHARTER_FOUND: $charter"
  cat "$charter"
else
  echo "NO_CHARTER — using defaults (no brand constraints)"
fi
```

χ ∃ → parse brand identity: colors, style preferences, mood, avoidances.
χ ∄ → proceed without brand constraints — inform user they can create one from `examples/visual-charter.example.json`.
Check φ and load if ∃.

## Phase 2 — Accept Concept & Intake

1. Concept ∄ via $ARGUMENTS → AskUserQuestion: "What image do you want to create? Describe subject, context, any specific requirements."

2. Ask structured follow-up (one message, all at once):
   - **Platform**: Instagram / LinkedIn / website / presentation / thumbnail / other
   - **Content type**: personal brand / product / educational / promotional / lifestyle / other
   - **Mood/tone**: professional / warm / dramatic / energetic / minimal / mysterious / other
   - **Style preference**: photographic / illustrated / 3D / no preference (optional override)
   - **Aspect ratio**: square 1:1 / portrait 4:5 or 9:16 / landscape 16:9 / no preference

3. Parse into creative brief: Subject | Context | Platform | Content type | Mood | Style | Aspect ratio

4. AskUserQuestion: "Do you want your face/likeness in the image? (yes/no)"
   - yes → Phase 2.5
   - no → Phase 2.75 (skip to Phase 3)

## Phase 2.5 — Face Reference Resolution

Execute only if user confirmed face in image.

1. φ found in Phase 1 → display summary: "Using your saved face reference: [description]. Still accurate? (yes/update)"
   - update → ask new description, overwrite file
2. φ ∄ → ask: "Describe your appearance (hair color/style, eye color, age range, skin tone, distinctive features)."
3. Save to vault:

```bash
mkdir -p "$HOME/.roxabi-vault/config"
cat > "$HOME/.roxabi-vault/config/face-reference.json" << EOF
{
  "description": "FACE_DESCRIPTION",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
```

4. Store as FACE_DESC — injected into Subject component of ∀ prompt variant in Phase 4.

## Phase 3 — Load Style References

```bash
echo "=== Loading references ==="
plugin_dir=$(dirname "$(dirname "$(dirname "$0")")")
for ref in references/artistic_styles.md references/prompt_best_practices.md; do
  if [ -f "$ref" ]; then
    echo "LOADED: $ref"
  fi
done
```

Read `references/artistic_styles.md` (available styles) and `references/prompt_best_practices.md` (prompt structure, platform tips).

## Phase 4 — Generate Prompt Variants

Generate 4-6 variants from creative brief. ∀ variant includes:

| Component | Description |
|-----------|-------------|
| **Style** | Artistic style from references — user style preference → lead with that; ∄ → distribute across categories |
| **Subject** | Detailed description — FACE_DESC ∃ → prepend: "[FACE_DESC], [rest of subject]" |
| **Composition** | Framing/perspective matched to target aspect ratio |
| **Lighting** | Source and quality matched to mood |
| **Color palette** | Dominant colors/harmony — χ ∃ → informed by brand charter |
| **Mood** | Emotional tone matched to brief |
| **Technical** | Resolution, aspect ratio, platform-specific rendering |

Variant distribution: style preference given → 2-3 in that direction + 1-2 creative divergences. ∄ preference → 1-2 photographic, 1-2 illustration/digital art, 1 stylized, 1 experimental.

## Phase 5 — Apply Brand Identity

χ ∃ → apply to ∀ variant:
1. **Colors** — incorporate brand palette (primary, secondary, accent)
2. **Style alignment** — match brand aesthetic and mood
3. **Avoidances** — exclude brand avoid list
4. **Preferences** — emphasize brand prefer list

Mark each: **On-brand** / **Near-brand** / **Off-brand** (deliberate divergence).

## Phase 6 — Present Variants

Auto-save all variants before presenting:

```bash
save_dir="$HOME/.roxabi-vault/image-prompts"
mkdir -p "$save_dir"
date_prefix=$(date +%Y%m%d)
slug=$(echo "USER_CONCEPT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/-\{2,\}/-/g' | sed 's/^-\|-$//g' | cut -c1-40)
save_file="$save_dir/${date_prefix}_${slug}.md"
# Write concept, face reference (if used), and all variants to the file
echo "# Image Prompts — USER_CONCEPT" > "$save_file"
echo "Date: $date_prefix" >> "$save_file"
# Append each variant block
echo "Saved to: $save_file"
```

Present in structured format:

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

AskUserQuestion: **Pick one** (variant number) | **Refine** (variant + changes) | **Regenerate** (different styles) | **Batch** (run generate_prompt_variants.py)

## Phase 7 — Batch Generation (Optional)

```bash
python3 scripts/generate_prompt_variants.py \
  --concept "user concept here" \
  --charter "$HOME/.roxabi-vault/config/visual-charter.json" 2>/dev/null || \
python3 scripts/generate_prompt_variants.py \
  --concept "user concept here"
```

Present batch results for selection.

$ARGUMENTS
