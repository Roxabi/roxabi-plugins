---
name: logo-explore-ai
description: 'Batch-generate 25+ AI logo concepts using Flux — rapid visual exploration with comparison gallery. Triggers: "explore logo ideas" | "ai logo concepts" | "batch logo concepts" | "logo image generation" | "logo concepts with ai".'
version: 0.2.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch, AskUserQuestion
---

# Logo Explore (AI)

**Goal:** Batch-generate 25+ logo concepts as raster images using AI (Flux model), display in a comparison gallery, iterate on favorites.

Let:
  B := `$HOME/.roxabi-vault/config/visual-charter.json`
  P := `<project-root>/brand/prompts/`
  O := `<project-root>/brand/concepts/`

## Phase 1 — Context Discovery

1. Identify target project: `$ARGUMENTS` name/path → cwd (`CLAUDE.md`, `README.md`, `package.json`, `pyproject.toml`).

2. Check brand assets:
```bash
charter="$HOME/.roxabi-vault/config/visual-charter.json"
[ -f "$charter" ] && echo "CHARTER_FOUND" && cat "$charter" || echo "NO_CHARTER"
```

3. Research project identity: read `CLAUDE.md`, `README.md`, docs, configs — extract purpose, architecture, metaphors, personality.

4. Discover image generation environment:
```bash
for p in "$IMAGECLI_VENV" "$IMAGECLI_HOME/.venv" "$HOME/projects/imageCLI/.venv"; do
  [ -x "$p/bin/python3" ] && echo "VENV_FOUND: $p" && break
done
nvidia-smi --query-gpu=name,memory.free,memory.total --format=csv,noheader 2>/dev/null || echo "NO_GPU"
nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader,nounits 2>/dev/null
```

¬GPU ∨ ¬venv → abort with instructions. GPU conflict found → WARN via `AskUserQuestion`: "Process X is using the GPU. Stop it first, or proceed anyway?" Do NOT auto-kill.

## Phase 2 — Concept Directions

Propose 5 directions (visual style + metaphor) via `AskUserQuestion` multi-select. Ask to confirm/modify/add. Aim: 4-5 directions × ~5 variations = 20-25 concepts.

## Phase 3 — Prompt Engineering

∀ direction: write 4-5 `.md` prompt files in P:

```markdown
---
engine: flux2-klein
width: 1024
height: 1024
steps: 28
guidance: 4.5
negative_prompt: "blurry, low quality, watermark, ugly, text, letters, words, typography, font"
---

<prompt body — 3-6 sentences>
```

See `${CLAUDE_PLUGIN_ROOT}/examples/prompt.example.md` for reference.

Rules: exact hex colors from charter; describe composition + background; reference render quality; state use case; ¬text/typography; vary angle/lighting/materials/detail per prompt. Filenames: `01-frosted-glass-hex.md`, `02-frosted-glass-angled.md`, etc.

## Phase 4 — Batch Generation

```bash
mkdir -p "$brand_dir/concepts"
"$VENV_PATH/bin/python3" "${CLAUDE_PLUGIN_ROOT}/scripts/generate-batch.py" \
  "$brand_dir/prompts/" --output-dir "$brand_dir/concepts/"
```

Model loads once, generates sequentially (~20s each, int8 quantization). Failure → check `nvidia-smi`; reduce to 512×512; free GPU memory.

## Phase 5 — Gallery

1. Read `${CLAUDE_PLUGIN_ROOT}/scripts/gallery-template.html`.
2. Build `IMAGES` array from generated PNGs + prompt metadata.
3. Replace `// __IMAGES_DATA__` with `const IMAGES = [...]`; optionally set `const PROJECT_NAME`.
4. Write to `<project-root>/brand/concepts-gallery.html`.
5. `xdg-open "$brand_dir/concepts-gallery.html"`

## Phase 6 — Pick & Iterate

Ask via `AskUserQuestion`: "Pick favorites by number, generate more variations, or done?"

- Favorites + variations → new prompts (different angles/lighting/colors/materials) → re-run batch (existing PNGs skipped) → regenerate gallery.
- Done → summarize favorites; suggest: `/logo-design` for animated SVG, `/logo-explore-svg` for shape variations.

$ARGUMENTS
