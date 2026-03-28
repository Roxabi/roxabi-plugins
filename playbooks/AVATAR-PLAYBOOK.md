# Agent Avatar Creation Playbook

_How to create, select, and deploy a photorealistic avatar for any Lyra agent._

---

## Overview

Each agent gets a **human face** — warm, real, imperfect. Not anime, not abstract, not stock-photo polished. The avatar must reflect the agent's personality at a glance.

This playbook covers the full pipeline: prompt design → batch exploration → selection → final render → platform deployment.

> **Prerequisite:** Agent personality must be defined before starting avatar creation. The avatar is a visual translation of the personality — without a clear persona (warmth level, tone, expertise, voice), the visual direction has no anchor and exploration will drift.
>
> A dedicated **Personality Creation Playbook** is planned. Until then, refer to `brand/AGENT-META-PROMPT.md` for the PersonaConfig schema and agent family spectrum.

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

### API endpoint

Galleries discover their images dynamically via:

```
GET /api/list/brand/concepts/avatar
→ [{"name": "001-expr-calm-neutral.png", ...}, ...]
```

No hardcoded lists — images appear automatically as they are generated. If the server is not running or the directory is empty, the gallery shows an empty state with the batch command to run.

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
| **★ STARRED filter** | Shows only starred images, count updates live |
| **V2 badge** | Orange badge on V2 cards for visual distinction |
| **Lightbox** | Click any card → full-size view, keyboard navigation (←→ keys) |
| **Star in lightbox** | ★ button in lightbox header — star while viewing full-size |
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

The avatar gallery is a standalone HTML file that auto-discovers images via the `/api/list` API. When adding a new agent or new batch round, update or create the gallery.

### Single-batch gallery (new agent)

Copy `brand/avatar-gallery.html` and update these constants:

```javascript
const BASES = {
  v1: 'concepts/avatar-<agent>/',
};
const API_PATHS = {
  v1: '/api/list/brand/concepts/avatar-<agent>',
};
```

Add filter category tags to match your prompt filename prefixes (e.g. `001-expr-*` → category `EXPRESSION`).

### Multi-batch gallery (V1 + V2)

When V2 is ready, update `API_PATHS` and `BASES` to include both:

```javascript
const BASES = {
  v1: 'concepts/avatar-<agent>/',
  v2: 'concepts/avatar-<agent>-v2/',
};
const API_PATHS = {
  v1: '/api/list/brand/concepts/avatar-<agent>',
  v2: '/api/list/brand/concepts/avatar-<agent>-v2',
};
```

The gallery fetches both in parallel with `Promise.all()`, tags each item with `batch: 'v1'` or `batch: 'v2'`, and adds a V2 badge on cards from the second round.

### Starring persistence

Stars are saved to `localStorage` under a per-gallery key:

| Gallery | localStorage key |
|---|---|
| Avatar (Lyra) | `lyra-avatar-starred` |
| Logo Concepts | `lyra-concepts-starred` |
| New agent | `lyra-<agent>-starred` (set in gallery JS) |

Stars survive page refresh. They are **not** server-side — if you clear localStorage or switch browser, stars are lost. Export them before clearing.

### Logo/Concepts gallery

`brand/concepts-gallery.html` uses the same pattern for AI-generated logo concepts:
- API: `/api/list/brand/concepts/`
- Categories derived from filename prefix (e.g. `forge-amber-*`, `forge-arch-*`)
- Same starring system, same lightbox
- Used during brand exploration for logo round selection (see `BRAND-EXPLORATION-PLAYBOOK.md`)

---

## 8. Generate Batch V2 (Refinement)

Create 36 new prompts in `brand/prompts/avatar-<agent>-v2/` focused on the starred patterns. Tighten the expression gradient, keep the winning lighting, expand the best diversity range.

Same batch command as V1.

---

## 9a. Pick the Finalist

View each candidate with fresh eyes. Pick one. Commit.

The right face will feel obvious when you see it — you'll know it's the agent before you can explain why.

---

## 10. Generate Final at 1024×1024

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

> First run at 1024×1024 triggers Triton kernel compilation — takes 5–10 minutes. Subsequent runs are fast.

---

## 11. Create Telegram Description Banner

640×360 pixels. Shows in "What can this bot do?" block.

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

## 13. Face Locking (PuLID Flux2)

### Prerequisites
- ComfyUI installed on Machine 2 (Pop!_OS) — see `brand/workflows/lyra-face-lock-README.md`
- `flux2-klein-4B` checkpoint available
- `iFayens/ComfyUI-PuLID-Flux2` node installed
- ⚠️ imageCLI must not be running (shared 16 GB VRAM)

### Workflow
<!-- TODO (Slice 2 / #422): fill in step-by-step after first run -->
See `brand/workflows/lyra-face-lock.json` + README for node chain.

### Tuning Reference
<!-- TODO (Slice 2 / #422): fill in from quality gate results -->

| Setting | Value | Effect |
|---------|-------|--------|
| `pulid_strength` | 0.6 | Recommended starting point |
| `pulid_method` | `fidelity` | Strong identity lock |
| `end_at` | 1.0 → 0.6 | Reduce to allow more pose freedom |

### VRAM Budget
- flux2-klein-4B + PuLID: ~14–16 GB (at Machine 2 ceiling)
- Machine 1 (RTX 3080, 10 GB): cannot run this workload
- OOM mitigations: cap 1024×1024, `--lowvram`, avoid running imageCLI concurrently

### Shape C trigger
<!-- TODO (Slice 3 / #423): update with actual issue number -->
When ≥25 diverse face-locked images exist in `brand/concepts/avatar-final/face-locked/`,
open the Shape C LoRA training issue (see #419 for context).

---

## File Structure

```
brand/
  prompts/
    avatar-<agent>/          # V1 prompts (36-40 × .md)
    avatar-<agent>-v2/       # V2 refined prompts (36 × .md)
    avatar-final/            # Final prompt at 1024×1024
  concepts/
    avatar-<agent>/          # V1 generated PNGs
    avatar-<agent>-v2/       # V2 generated PNGs
    avatar-final/            # Final PNG + Telegram banner (640×360)
  avatar-gallery.html        # Multi-batch gallery with starring (V1 + V2)
  concepts-gallery.html      # Logo/icon concepts gallery (same pattern)
  avatar-final.html          # Single-image showcase page for final avatar
  AVATAR-PLAYBOOK.md         # This file

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
| Banner creation | 5 min | 640×360 PNG |
| Deployment | 5 min | Live on all platforms |
| **Total** | **~2h** | **Deployed avatar** |
