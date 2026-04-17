# Avatar Creation Playbook

_How to create, select, and deploy a photorealistic avatar for any agent._

> **See also:**
> - [AVATAR-PIPELINES.md](AVATAR-PIPELINES.md) — face-lock pipelines, LoRA training, strategy comparison
> - [AVATAR-LESSONS.md](AVATAR-LESSONS.md) — hard-won lessons from banding, training data, identity blocks
> - [AVATAR-LOG.md](AVATAR-LOG.md) — per-version experiment history (V1–V22)

---

## 1. Define the Agent's Visual Direction

Before generating anything, answer these questions:

| Question | Lyra example | Aryl example |
|---|---|---|
| **Warmth level** | High — inviting, approachable | Low — precise, contained |
| **Expression anchor** | "Just solved it" quiet smile | Focused neutral |
| **Energy** | Present, in flow | Analytical, deliberate |
| **Age range** | Mid-20s | Late-20s to early 30s |
| **Hair** | Loose, natural, slightly tousled | Pulled back or short, controlled |
| **Lighting** | Studio key + Forge Orange rim | Even, cooler, minimal rim |

Write a one-line **expression anchor** — the single emotion the face must convey. This drives every prompt variation.

> **Prerequisite:** Agent personality must be defined before starting avatar creation. The avatar is a visual translation of the personality — without a clear persona (warmth level, tone, expertise, voice), the visual direction has no anchor and exploration will drift.
>
> A dedicated **Personality Creation Playbook** is planned. Until then, refer to `brand/AGENT-META-PROMPT.md` for the PersonaConfig schema and agent family spectrum.

---

## 2. Create Prompt Variations

Store prompts in `brand/prompts/avatar-<agent>/` as individual `.md` files with YAML frontmatter.

### Standard frontmatter
```yaml
---
engine: flux2-klein
width: 400
height: 400
steps: 20
guidance: 4.0
---
```

### Prompt template
```
Editorial portrait photograph. [age, ethnicity, hair]. Full frontal.
Expression: [expression anchor — specific, not generic].

[Lighting description]. Forge Orange rim (#e85d04) [intensity].
Obsidian background (#0a0a0f). Head and upper shoulders, shallow DOF.
Photorealistic, natural skin.
```

### Variation matrix (aim for 36–40 prompts)

| Category | Variations |
|---|---|
| **Expression gradient** | 8 — from neutral → full warmth, each with specific descriptor |
| **Lighting** | 8 — studio, rim intensity, split, Rembrandt, backlit, window |
| **Diversity** | 8 — skin tones, ethnicities, stay within personality direction |
| **Hair** | 5 — texture and style variations |
| **Age** | 4 — early 20s → early 30s |
| **Crop/gaze** | 3 — tighter, wider, gaze angle |

> **Key rule:** Use specific, cinematic language. Not "smiling" — "the look of someone who just solved something, slight satisfied smile, eyes bright with quiet pride, not showing off."

---

## 3. Generate Batch V1 (Exploration)

```bash
# Ensure enough system RAM (~12+ GB available)
free -h

# Run batch
cd ~/projects/imageCLI
uv run imagecli batch ~/projects/lyra/brand/prompts/avatar-<agent>/ \
  --output-dir ~/projects/lyra/brand/concepts/avatar-<agent>/
```

### RAM notes
- flux2-klein needs ~12 GB system RAM at startup, ~15.5 GB VRAM during inference
- If preflight check fails, close heavy applications and retry
- The `vram_gb` threshold in `src/imagecli/engines/flux2_klein.py` can be lowered to `12.0` if system RAM consistently reads below 13.0 GB
- Multiple Claude Code sessions running in parallel eat ~700 MB RAM — close other sessions if needed

Each image: ~35 seconds. 38 images ≈ 22 minutes.

### Seed reproducibility

Every generated image must have its seed recorded for reproducibility.

- **imageCLI**: when no seed is provided, a random seed is auto-generated. Seed is embedded in PNG metadata (readable with `Image.open(f).text['seed']`). Also embeds: engine, steps, guidance, width, height.
- **Two-phase scripts**: use deterministic seeds (`42 + i` for image index `i`). Seeds saved in PNG metadata.
- **006 was generated before this fix — its seed is lost forever.** The face only exists as that one PNG. This is why seed logging matters.

```python
# Read seed from any image generated after this fix:
from PIL import Image
img = Image.open("output.png")
print(img.text)  # {'seed': '12345', 'engine': 'flux2-klein', 'steps': '28', ...}
```

---

## 4. Gallery Infrastructure

All brand galleries are served by a shared local HTTP server — never opened as `file://`.

### Server setup

```bash
# Check if already running
ps aux | grep serve.py

# Start if not running (runs on port 8080)
python3 ~/.agent/diagrams/serve.py &
```

The server at `~/.agent/diagrams/serve.py`:
- Serves static files from `~/.agent/diagrams/`
- Exposes `/api/list/<path>` — returns a JSON listing of files in that directory
- A symlink bridges it to the project: `~/.agent/diagrams/brand/` → `~/projects/lyra/brand/`

This means `http://localhost:8080/brand/` maps to `~/projects/lyra/brand/`.

### Image discovery

**Deployed (Cloudflare Pages)**: galleries discover images via static `manifest.json` files in each batch directory. These are generated by `gen-image-manifests.py` as part of `make diagrams deploy`. The gallery fetches `<batch-dir>/manifest.json` at load time.

**Local dev**: `serve.py` exposes `/api/list/<path>` which returns a live directory listing — galleries fall back to this when `manifest.json` is absent. Images appear automatically as they are generated; no hardcoded lists.

If the server is not running or the directory is empty, that batch shows an empty state.

### Symlink setup (first time on a new machine)

```bash
ln -s ~/projects/lyra/brand ~/.agent/diagrams/brand
```

---

## 5. Browse & Star

Open the avatar gallery:

```
http://localhost:8080/brand/avatar-gallery.html
```

### Gallery features

| Feature | Detail |
|---|---|
| **Batch tabs** | ALL / V1 / V2 — switch between generation rounds |
| **Filter buttons** | ALL, STUDIO, EVENING, MINIMAL, CALM, FOCUSED, DIRECT, SMILE, FRONTAL, 3-QUARTER, DIVERSITY, EXPRESSION, LIGHTING, AGE, HAIR, CROP/GAZE |
| **STARRED filter** | Shows only starred images, count updates live |
| **V2 badge** | Orange badge on V2 cards for visual distinction |
| **Lightbox** | Click any card → full-size view, keyboard navigation (← → keys) |
| **Star in lightbox** | button in lightbox header — star while viewing full-size |
| **Persistence** | Stars saved to `localStorage` key `lyra-avatar-starred` — survive page reload |

### Starring principles

Star freely. Don't overthink. You're not committing — you're building a signal.

Look specifically for:
- The face that **is** the agent, not the face that looks best in isolation
- Expressions that match the personality anchor
- Lighting that fits the brand (Forge Orange rim = right energy)

---

## 6. Analyze Starred Patterns

After starring 10–20 candidates, tally:

| Dimension | What to count | Decision |
|---|---|---|
| **Expression** | Which specific expressions? | Defines V2 expression gradient |
| **Lighting** | Studio / rim / natural / split | Lock the winning lighting family |
| **Hair** | Loose / tousled / straight / curly | Defines V2 hair range |
| **Diversity** | Which heritages got starred? | Expand that range in V2 |
| **Crop** | Tight face / more shoulder? | Adjust V2 framing |
| **Not starred** | What got ignored? | Kill those directions in V2 |

**Lyra V1 example (15 starred out of 38):**
- Loose hair: 13/15 → keep
- Frontal crop: 11/15 → keep
- Studio + Forge Orange rim: 9/15 → keep
- Smile or calm: 11/15 combined → expression gradient confirmed
- Not starred: analytical gaze, pulled-back hair, most diversity except mixed heritage

These patterns drove V2: tighter expression gradient, locked studio+rim lighting, expanded wavy/curly hair, kept diversity in sweet spot.

---

## 7. Create or Extend the Gallery HTML

The avatar gallery is a standalone HTML file deployed to Cloudflare Pages. Images are discovered via `manifest.json` files generated at build time.

### Batch registry — single source of truth

The gallery uses a `BATCHES` array as the single config. **Adding a new batch requires exactly one edit** — one entry in this array:

```javascript
const BATCHES = [
  { id:'v1',  label:'Exploration',    dir:'concepts/avatar/',                catalogue: CATALOGUE    },
  { id:'v2',  label:'Pattern Drill',  dir:'concepts/avatar-v2/',             catalogue: CATALOGUE_V2 },
  // ...
  { id:'v11', label:'My New Batch',   dir:'concepts/avatar-lyra-v11/',       catalogue: CATALOGUE_V9 },
];
```

Everything else derives from `BATCHES` automatically:
- Batch bar buttons are generated in the boot function — no hardcoded HTML
- `discover()` maps over `BATCHES` and fetches each `manifest.json`
- Per-batch counts are computed in a single pass
- Subtitle string built from `BATCHES` in reverse order
- Badge CSS class is `badge-<id>` (add a new `.badge-v11 { ... }` rule if needed)

### Adding a new batch: checklist

1. Generate images to `~/.agent/lyra/brand/concepts/avatar-lyra-v<N>/`
2. Add one entry to `BATCHES` in `avatar-gallery.html`
3. Add one `CATALOGUE_V<N>` constant above `BATCHES` (or reuse an existing one if prompts are identical)
4. Add one `.badge-v<N>` CSS rule in the `<style>` block
5. Run `make diagrams deploy`

### Versioning convention

| Slot | Directory | Label |
|---|---|---|
| V1 | `avatar/` | Exploration |
| V2 | `avatar-v2/` | Pattern Drill |
| V3 | `avatar-training/` | Training Set |
| V4 | `avatar-test-pulid/` | PuLID Test |
| V5 | `avatar-pulid-v2/` | Goddess/Marvel |
| V6 | `avatar-pulid-v4-fix/` | PuLID Fixed |
| V8 | `avatar-lyra-final/` | Lyra Final (special effects) |
| V9 | `avatar-lyra-portraits/` | Lyra Portraits (INT8, banding) |
| V10 | `avatar-lyra-v10/` | Portraits FP8 (float8, residual banding) |
| V11 | `avatar-lyra-v11/` | 8-Step Match (FP8, steps=8, prompt-aligned to 006 ref) |
| V15-1024 | `avatar-lyra-v15-1024/` | Pipeline comparison + PuLID tuning tests (1024x1024) |
| V16 | `avatar-lyra-v16/` | LoRA training set (FLUX.1-dev + PuLID) |
| V17 | `avatar-lyra-v17/` | LoRA checkpoint comparison |
| V18 | `avatar-lyra-v18/` | Klein 4B exploration (identity block v1) |
| V19 | `avatar-lyra-v19/` | Klein 4B exploration (identity block v2) |
| V20 | `avatar-lyra-v20/` | Brute force (face scoring against ref) |
| V21 | `avatar-lyra-v21/` | Brute force (AntelopeV2, island detection) |
| V22-phase1 | `avatar-lyra-v22-phase1/` | Seed selection (10 seeds x 50 prompts) |
| V22-phase2 | `avatar-lyra-v22-phase2/` | Full run (dual face+CLIP scoring, island-based LoRA selection) |

V7 was skipped (renumbering error — `avatar-lyra-final` was initially mislabeled V7 before correction).

> **Detailed per-version results:** see [AVATAR-LOG.md](AVATAR-LOG.md)

### Starring persistence

Stars are saved to `localStorage` under a per-gallery key:

| Gallery | localStorage key |
|---|---|
| Avatar (Lyra) | `lyra-avatar-starred` |
| Logo Concepts | `lyra-concepts-starred` |
| New agent | `lyra-<agent>-starred` (set in gallery JS) |

Stars survive page refresh. They are **not** server-side — if you clear localStorage or switch browser, stars are lost.

### Logo/Concepts gallery

`brand/concepts-gallery.html` uses the same pattern for AI-generated logo concepts:
- Categories derived from filename prefix (e.g. `forge-amber-*`, `forge-arch-*`)
- Same starring system, same lightbox
- Used during brand exploration for logo round selection (see `BRAND-EXPLORATION-PLAYBOOK.md`)

---

## 8. Generate Batch V2 (Refinement)

Create 36 new prompts in `brand/prompts/avatar-<agent>-v2/` focused on the starred patterns. Tighten the expression gradient, keep the winning lighting, expand the best diversity range.

Same batch command as V1.

---

## 9. Pick the Finalist

View each candidate with fresh eyes. Pick one. Commit.

The right face will feel obvious when you see it — you'll know it's the agent before you can explain why.

---

## 10. Generate Final at 1024x1024

```bash
# Create prompt file
mkdir -p ~/projects/lyra/brand/prompts/avatar-final/
# Copy winning prompt, change size + steps:
# width: 1024, height: 1024, steps: 28
```

```bash
cd ~/projects/imageCLI
uv run imagecli batch ~/projects/lyra/brand/prompts/avatar-final/ \
  --output-dir ~/projects/lyra/brand/concepts/avatar-final/
```

> First run at 1024x1024 triggers Triton kernel compilation — takes 5–10 minutes. Subsequent runs are fast.

---

## 11. Create Telegram Description Banner

640x360 pixels. Shows in "What can this bot do?" block.

Use the Pillow compositor script pattern:
- Left side: solid obsidian, Forge Orange accent bar, agent name + tagline + capabilities
- Right side: avatar face fading in from the left edge
- Gradient fade zone: ~200px, power curve 1.6–1.8

Output: `brand/concepts/avatar-final/telegram-description-640x360.png`

---

## 12. Deploy

### Profile picture (round avatar)
- **Discord**: Set programmatically via `PATCH /users/@me` with base64 avatar
- **Telegram**: BotFather → `/setuserpic` → select bot → send `006-just-solved-1024.png`

### Description picture (banner)
- **Telegram**: BotFather → `/setdescriptionpicture` → select bot → send banner
- Send images to user via bot first for easy forwarding to BotFather

---

## 13. Face Locking & LoRA Training

For face-locked generation and LoRA training pipelines, see [AVATAR-PIPELINES.md](AVATAR-PIPELINES.md):
- Klein 9B + PuLID (two-phase, deprecated)
- FLUX.1-dev + PuLID (for on-the-fly face lock without a trained LoRA)
- Klein 4B LoRA training (Strategy C)
- **Klein 4B + LoRA via runtime NVFP4 (Strategy D — current production choice, V22 validated)**
- Strategy comparison and decision matrix

> **Production default (V22 validated 2026-04-05):** use the `flux2-klein-fp4 --lora PATH` engine path. ~4s per 1024×1024 image, ~3 GB VRAM, ~0.64 centroid similarity to training set. Long descriptive prompts, 8 steps, scale 1.0 (do not touch the scale lever — see [AVATAR-LESSONS.md](AVATAR-LESSONS.md)).

> **Shape C trigger:** when 200+ face-locked images exist in training data, proceed to LoRA training. See [AVATAR-PIPELINES.md](AVATAR-PIPELINES.md) for the full guide.

---

## File Structure

```
brand/
  prompts/
    avatar-<agent>/          # V1 prompts (36-40 x .md)
    avatar-<agent>-v2/       # V2 refined prompts (36 x .md)
    avatar-final/            # Final prompt at 1024x1024
  concepts/
    avatar-<agent>/          # V1 generated PNGs
    avatar-<agent>-v2/       # V2 generated PNGs
    avatar-final/            # Final PNG + Telegram banner (640x360)
  avatar-gallery.html        # Multi-batch gallery with starring (V1 + V2)
  concepts-gallery.html      # Logo/icon concepts gallery (same pattern)
  avatar-final.html          # Single-image showcase page for final avatar
  AVATAR-PLAYBOOK.md         # This file — reusable workflow
  AVATAR-PIPELINES.md        # Pipeline reference + LoRA training
  AVATAR-LESSONS.md          # Lessons from failures
  AVATAR-LOG.md              # Per-version experiment history

~/.agent/diagrams/
  serve.py                   # Local HTTP server (port 8080)
  brand/                     # Symlink → ~/projects/lyra/brand/
```

### Symlink check

```bash
ls -la ~/.agent/diagrams/brand
# Should show: brand -> /home/mickael/projects/lyra/brand
# If missing: ln -s ~/projects/lyra/brand ~/.agent/diagrams/brand
```

---

## Quick Reference

| Step | Time | Output |
|---|---|---|
| Prompt design | 30 min | 36–40 `.md` files |
| Batch V1 | ~22 min | 38 PNGs |
| Gallery setup | 5 min | `avatar-gallery.html` serving on localhost |
| Gallery review + starring | 15 min | Starred list |
| Pattern analysis | 5 min | V2 direction |
| Batch V2 | ~21 min | 36 PNGs |
| Gallery V2 update | 2 min | Multi-batch gallery with V2 tab |
| Finalist selection | 10 min | 1 winner |
| Final render 1024px | ~3 min + 10 min Triton compile (first time) | 1 PNG |
| Showcase page | 5 min | `avatar-final.html` |
| Banner creation | 5 min | 640x360 PNG |
| Deployment | 5 min | Live on all platforms |
| **Total (avatar)** | **~2h** | **Deployed avatar** |

### Face lock & LoRA (see AVATAR-PIPELINES.md)

| Strategy | Setup time | Per-image time (1024×1024) | Centroid score | VRAM |
|----------|-----------|----------------|---------|------|
| **A: `pulid-flux1-dev`** | 0 (ready now) | ~42s | ~0.55 | ~10 GB |
| **B: Klein 4B + projection** | ~1h (code fix) | ~35s | Unknown | ~10 GB |
| **C: Klein 4B LoRA via `flux2-klein --lora`** | ~4h (data gen + training) | ~20s | **0.63–0.66** | ~8 GB |
| **D: Klein 4B LoRA via `flux2-klein-fp4 --lora`** (production) | 0 once LoRA exists | **~4s** | **0.61–0.64** | **~3 GB** |
