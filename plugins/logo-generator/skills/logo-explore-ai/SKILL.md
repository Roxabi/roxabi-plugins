---
name: logo-explore-ai
description: 'Batch-generate 25+ AI logo concepts using Flux — rapid visual exploration with comparison gallery. Triggers: "explore logo ideas" | "ai logo concepts" | "batch logo concepts" | "logo image generation" | "logo concepts with ai".'
version: 0.2.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch, AskUserQuestion
---

# Logo Explore (AI)

**Goal:** Batch-generate 25+ logo concepts as raster images using AI (Flux model), display in a comparison gallery, iterate on favorites.

## Phase 1 — Context Discovery

1. Identify the target project. Check (in order):
   - `$ARGUMENTS` for a project name or path
   - Current working directory for `CLAUDE.md`, `README.md`, `package.json`, `pyproject.toml`

2. Check for existing brand assets:

```bash
# Visual charter (for color consistency)
charter="$HOME/.roxabi-vault/config/visual-charter.json"
[ -f "$charter" ] && echo "CHARTER_FOUND" && cat "$charter" || echo "NO_CHARTER"
```

3. Research the project to understand its identity:
   - Read `CLAUDE.md`, `README.md`, docs, config files
   - Understand what the project does, its architecture, key concepts
   - Identify potential metaphors, shapes, and personality traits

4. Discover the image generation environment:

```bash
# Find imageCLI venv (needed for torch/diffusers)
for p in "$IMAGECLI_VENV" "$IMAGECLI_HOME/.venv" "$HOME/projects/imageCLI/.venv"; do
  [ -x "$p/bin/python3" ] && echo "VENV_FOUND: $p" && break
done

# Check GPU availability
nvidia-smi --query-gpu=name,memory.free,memory.total --format=csv,noheader 2>/dev/null || echo "NO_GPU"

# Check for GPU conflicts
nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader,nounits 2>/dev/null
```

If no GPU or venv found, abort with clear instructions. If other GPU processes are found, WARN via `AskUserQuestion`: "Process X is using the GPU. Stop it first, or proceed anyway?" Do NOT auto-kill.

## Phase 2 — Concept Directions

Based on project research, propose 5 concept directions. Each direction is a visual style + metaphor. Present via `AskUserQuestion` as multi-select:

```
Direction 1: "Frosted Glass Hex" — 3D hexagonal crystal with inner glow
Direction 2: "Constellation Dots" — luminous dots connected by thin lines
Direction 3: "Circuit Board" — flat PCB traces forming a geometric shape
Direction 4: "Liquid Metal" — flowing dark metal with light in cracks
Direction 5: "Origami" — folded paper with rim-lit edges
```

Ask the user to confirm, modify, or add directions. Aim for 4-5 directions with ~5 variations each = 20-25 total concepts.

## Phase 3 — Prompt Engineering

For each concept direction, write 4-5 `.md` prompt files in imageCLI format:

```markdown
---
engine: flux2-klein
width: 1024
height: 1024
steps: 28
guidance: 4.5
negative_prompt: "blurry, low quality, watermark, ugly, text, letters, words, typography, font"
---

<prompt body — 3-6 sentences describing the logo concept>
```

See `${CLAUDE_PLUGIN_ROOT}/examples/prompt.example.md` for reference.

Prompt engineering rules:
- Specify exact hex colors from the visual charter (e.g., "warm orange (#FF6B35)")
- Describe composition: "centered", "floating", "on pure black background (#0D0D0D)"
- Reference render quality: "4K render", "studio lighting", "physically-based rendering"
- State the use case: "suitable as a software brand icon"
- Never ask for text/typography in the image — AI struggles with text
- Vary each prompt within a direction: different angles, lighting, materials, detail levels

Write all prompts to `<project-root>/brand/prompts/`. Use numbered filenames: `01-frosted-glass-hex.md`, `02-frosted-glass-angled.md`, etc.

## Phase 4 — Batch Generation

Run the batch generation script using the imageCLI venv:

```bash
brand_dir="<project-root>/brand"
mkdir -p "$brand_dir/concepts"

"$VENV_PATH/bin/python3" "${CLAUDE_PLUGIN_ROOT}/scripts/generate-batch.py" \
  "$brand_dir/prompts/" \
  --output-dir "$brand_dir/concepts/"
```

This loads the model once and generates all images sequentially (~20s each with int8 quantization).

If generation fails, suggest:
1. Check GPU processes: `nvidia-smi`
2. Reduce image size: add `--width 512 --height 512` to prompts
3. Free GPU memory by stopping other services

## Phase 5 — Gallery

Build a comparison gallery from the generated images:

1. Read `${CLAUDE_PLUGIN_ROOT}/scripts/gallery-template.html`
2. Build the `IMAGES` array from the generated PNG files + prompt metadata (label from filename, style from prompt summary)
3. Replace `// __IMAGES_DATA__` with `const IMAGES = [...]` and optionally `const PROJECT_NAME = "<name>"`
4. Write to `<project-root>/brand/concepts-gallery.html`
5. Open in browser: `xdg-open "$brand_dir/concepts-gallery.html"`

## Phase 6 — Pick & Iterate

Ask via `AskUserQuestion`: "Pick favorites by number, generate more variations, or done?"

- **Pick favorites + more variations:** Write new prompts with variations on the favorites (different angles, lighting, colors, materials). Re-run batch — existing PNGs are skipped automatically. Regenerate gallery.
- **Done:** Summarize the selected favorites. Suggest next steps:
  - "Use `/logo-design` to develop a favorite into an animated SVG logo"
  - "Use `/logo-explore-svg` to explore shape variations"

$ARGUMENTS
