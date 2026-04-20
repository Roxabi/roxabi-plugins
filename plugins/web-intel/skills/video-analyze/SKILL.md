---
name: video-analyze
argument-hint: '<url> [--no-derivatives]'
description: 'Video VLM analysis — download video, extract frames via scene detection, run two-pass VLM classify + deep-OCR, emit frame descriptions + OCR derivatives (text frames · recurring terms · top-dense · digest). Triggers: "video analyze" | "analyze video" | "vlm video" | "video vlm" | "extract frames" | "video analysis" | "ocr video".'
version: 0.2.0
allowed-tools: Bash, Read
---

# Video VLM Analysis

Download video → scene-detect frames → two-pass VLM (classify → deep-OCR) → derivative reports.

## Entry

```
/video-analyze https://youtube.com/watch?v=...
/video-analyze https://youtube.com/watch?v=... --no-derivatives
```

¬ URL → DP(B) for URL.

## Prerequisites

1. **VLM server running** — llama-server with Qwen3-VL (default `qwen3-vl-8b` @ `:8093`)
2. **Tools in PATH:** `yt-dlp`, `ffmpeg`, `nvidia-smi`
3. **GPU VRAM:** 2GB+ (2B model) · 6GB+ (8B model) · 15GB+ (Q5_K_M 8B + mmproj, qaya config)

Health check:

```bash
curl -s http://127.0.0.1:8093/health
```

## Step 1 — Locate Plugin

```bash
PLUGIN_ROOT=$(find ~/projects -maxdepth 4 -path "*/web-intel/pyproject.toml" -print -quit 2>/dev/null | xargs dirname)
if [ -z "$PLUGIN_ROOT" ]; then
  echo "ERROR: web-intel plugin not found"
  exit 1
fi
```

## Step 2 — Create Work Directory

```bash
WORK_DIR=~/.roxabi/forge/video-analysis-$(date +%Y%m%d-%H%M%S)
mkdir -p "$WORK_DIR"
```

For a named project, prefer `~/.roxabi/forge/<project-name>/` so companion artifacts (`PLAN.md`, `ANALYSIS.md`, `presentation.html`) sit beside the outputs — matches the [qaya precedent](~/.roxabi/forge/qaya-analysis/).

## Step 3 — Run VLM Pipeline

```bash
cd "$PLUGIN_ROOT" && uv run python scripts/video_vlm.py "$URL" \
  --work-dir "$WORK_DIR" \
  --scale-height 480 \
  --scene-threshold 0.2 \
  --deep-kinds schema,text,mixed,ui
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--base-url` | `http://127.0.0.1:8093/v1` | VLM server endpoint |
| `--model` | `qwen3-vl` | Model name |
| `--scale-height` | `720` | Frame resolution — **480 recommended** (4× cheaper prompt, equal/better OCR on dense grids per qaya Phase 1 sweep) |
| `--scene-threshold` | `0.2` | Scene detection sensitivity (0-1, lower = more sensitive). Auto-tuned up if frame budget exceeded. |
| `--deep-kinds` | `schema,text,mixed` | Frame kinds to deep-analyze in pass 2. **Add `ui`** for product / interface videos. |
| `--no-two-pass` | off | Skip classification, deep-analyze every frame (4× more expensive) |
| `--vram-check-every` | `5` | Sample VRAM every N frames |
| `--server-restart-script` | — | Path to bash launcher for auto-restart on health fail |

### Frame kinds (pass-1 classify)

| Kind | What it is | Deep-OCR by default? |
|---|---|---|
| `schema` | diagrams, architecture graphs | ✓ |
| `text` | title cards, slide text | ✓ |
| `mixed` | split-screen (presenter + schema/UI) | ✓ |
| `ui` | product UI, IDE screenshots | via `--deep-kinds` |
| `b_roll` | presenter, stock footage | short prompt only |

## Step 4 — Generate Derivatives

Unless `--no-derivatives`:

```bash
cd "$PLUGIN_ROOT" && uv run python scripts/analysis_derivatives.py "$WORK_DIR/analysis.json"
```

Writes:

| File | Content |
|---|---|
| `text_frames.md` | All `text`-kind frames — title cards, slide text (verbatim from VLM) |
| `terms.md` | Top recurring uppercase terms (≥3 occurrences) — likely acronyms / module names (e.g. `ED-LNN`, `OAD`, `WoE`) |
| `top20_dense.md` | Top-20 frames by description length — where the VLM found the most to describe |
| `digest.txt` | One line per frame: `ts \| kind \| chars \| ctok \| preview-80-chars` |

Re-runnable standalone on an existing `analysis.json` without redoing VLM work.

## Step 5 — Read Results

Output files in `$WORK_DIR/`:

| File | Content |
|------|---------|
| `analysis.json` | Full frame-by-frame descriptions + metadata + stats |
| `telemetry.jsonl` | Per-frame timing, tokens, VRAM |
| `vram.jsonl` | Periodic VRAM samples |
| `video.mp4` | Downloaded video |
| `frames/*.jpg` | Extracted frames (`scene_*.jpg` = scene-change, others = gap-fill) |
| `digest.txt` | Compact per-frame summary (derivative) |
| `text_frames.md` | Slide / title card text (derivative) |
| `terms.md` | Recurring uppercase terms (derivative) |
| `top20_dense.md` | Densest frames (derivative) |

Quick stats:

```bash
jq '.stats' "$WORK_DIR/analysis.json"
```

## Step 6 — Present Results

Summarize to the user:

1. **Totals** — frame count · by-kind breakdown · deep-analyzed count
2. **Runtime** — elapsed · VRAM peak
3. **Key findings** — scan `top20_dense.md` and `text_frames.md` for the high-signal items (architecture diagrams, title cards, acronyms worth explaining)
4. **Pointers** — path to `analysis.json` + each derivative

Example:

```
Video: https://youtube.com/watch?v=...
Frames: 150 (12 schema · 45 text · 8 ui · 65 b_roll · 20 mixed)
Deep analyzed: 77 frames
Elapsed: 556s (9.3 min) · VRAM peak: 14.2 GB

Key findings:
- [0:21] schema — ED-LNN → ECAD-LNN → OAD-LNN architecture
- [3:30] mixed — IDE footage (DecisionEngine.cs line 4382)
- [22:08] text — "Le monde de Qaya³" title card

Recurring terms: ED-LNN (7), OAD (36), ECAD (13), LOTAD (11), WoE (12)...

Outputs:
  ~/.roxabi/forge/<project>/analysis.json
  ~/.roxabi/forge/<project>/top20_dense.md
  ~/.roxabi/forge/<project>/text_frames.md
  ~/.roxabi/forge/<project>/terms.md
  ~/.roxabi/forge/<project>/digest.txt
```

## Synthesis (next step, manual)

For a full understanding-layer write-up, author `ANALYSIS.md` by hand — cross-check VLM frames against transcript (see [VIDEO-VOICE-PLAYBOOK Phase 1](../../../../../playbooks/VIDEO-VOICE-PLAYBOOK.md)). Use confidence markers:

- ★ verbatim from ≥2 sources (frame ∧ transcript)
- ◐ inferred / single-source
- ◯ single-frame, possibly OCR-hallucinated

## Error Handling

- **Server unreachable** → check `llama-server` process, offer restart command
- **VRAM OOM** → suggest smaller model or lower `--scale-height` (try 360)
- **Download fail** → verify URL, check `yt-dlp` version
- **Empty derivatives** → `analysis.json` missing `frame_descriptions` (VLM all-failed) — check `telemetry.jsonl` for server errors

$ARGUMENTS
