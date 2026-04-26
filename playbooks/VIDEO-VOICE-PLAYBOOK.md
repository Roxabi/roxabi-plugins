# VIDEO-VOICE Playbook — Umbrella

End-to-end: **reference video → full understanding → creator style → voice clone → script → render → companion page**.

Each phase below points to the **specialized skill / playbook**. This doc is the spine — it does not duplicate them.

---

## Pipeline

```
0  frame
1  understand-video   ─ PLAN · transcript · VLM · OCR · synthesis
2  writing-style      ─ creator tone / cadence / lexicon
3  voice-sample       ─ pick clean segment · import · active
4  storyboard         ─ scenes · timing · VO draft
5  vo-render          ─ narration.md → narration.wav
6  compose            ─ TSX kits
7  soundtrack         ─ VO (+ light BGM / SFX)
8  render             ─ MP4
9  companion-page     ─ forge slides / guide / epic
```

All phase-1 gaps shipped 2026-04-20 (see [§ Gaps](#gaps)). Next gaps will re-populate as usage surfaces them.

---

## Phase 0 — Frame

| | |
|---|---|
| Goal | audience · tone · format · length |
| Skill | `dev-core:frame` |
| Skip | quick-turn / one-shot |

---

## Phase 1 — Understand the video

**Method:** PLAN upfront → 3 parallel tracks (transcript · VLM · OCR) → cross-check synthesis. Based on the [qaya precedent](~/.roxabi/forge/qaya-analysis/) — transcript added to close the gap flagged in qaya's own ANALYSIS.md.

### 1.0 PLAN.md

Scaffold `~/.roxabi/forge/<project>/PLAN.md` — goal · phases · artifact table · confidence legend.

**Confidence legend** (used in synthesis):

| Marker | Meaning |
|---|---|
| ★ | verbatim from ≥2 sources (frame ∧ transcript) |
| ◐ | inferred from dense frames ∨ single-source transcript |
| ◯ | single-frame, possibly OCR-hallucinated |

### 1.1 Audio transcript

| Source | Command |
|---|---|
| YouTube captions | `yt-dlp --write-auto-subs --sub-lang fr --skip-download "$URL"` |
| Fallback (Whisper) | `voicecli transcribe video.mp4 -o transcript.md` |

Output → `transcript.md` (timestamped).

### 1.2 Visual VLM (two-pass)

#### 1.2.0 Preflight — VLM server + VRAM

The skill assumes `llama-server` is already running with a vision model on `:8093`. It does **not** auto-start it.

**Health check first:**

```bash
curl -sf http://127.0.0.1:8093/health && echo "✓ VLM up" || echo "✗ VLM down — start it"
```

**Start command** (qaya config, 480p sweet-spot — RTX 5070 Ti / RTX 3080):

```bash
llama-server \
  -m ~/.cache/llama-models/Qwen3-VL-8B-Instruct-Q5_K_M.gguf \
  --mmproj ~/.cache/llama-models/mmproj-Qwen3-VL-8B-BF16.gguf \
  --host 127.0.0.1 --port 8093 \
  --n-gpu-layers 99 --ctx-size 8192
```

**VRAM budget** (peaks, concurrent):

| Service | VRAM |
|---|---|
| VLM (Qwen3-VL-8B Q5_K_M + mmproj BF16) | ~7–8 GB |
| `voicecli_tts` daemon (qwen-fast) | ~7.4 GB |
| `voicecli_stt` daemon | ~2.2 GB |
| Compositor (cosmic-comp / KDE / GNOME) | ~0.5–6 GB (workstation) |

**Free VRAM before starting VLM** — on RTX 3080 (10 GB) this is mandatory, on RTX 5070 Ti (16 GB) recommended when compositor is heavy:

```bash
make -C ~/projects stt stop
make -C ~/projects tts stop
nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits   # expect ≥ 10 GB
```

Restart TTS/STT after Phase 1.2 completes (VLM can stay loaded through Phase 1.4 synthesis, must be stopped before Phase 5 VO render on 10 GB cards).

→ Full per-phase VRAM choreography: see [§ VRAM choreography](#vram-choreography) at end of file.

#### 1.2.1 Run

```bash
/video-analyze <url>
# pass 1: classify (b_roll / text / mixed / schema / ui)
# pass 2: deep-OCR on schema|text|mixed|ui only
```

Skill: [`web-intel:video-analyze`](../plugins/web-intel/skills/video-analyze/SKILL.md)

Output → `~/.roxabi/forge/<project>/`
- `analysis.json` · `frames/*.jpg` · `telemetry.jsonl` · `vram.jsonl`

Phase-1 probe (resolution sweep · multi-image concat · saturation) → see qaya `phase1_summary.md` — decide sweet-spot res (qaya = 480p @ Qwen3-VL-8B Q5_K_M).

### 1.3 OCR derivatives (auto)

From `analysis.json`:
- `text_frames.md` — title cards, slide text
- `terms.md` — top uppercase recurring terms (acronyms / module names)
- `top20_dense.md` — top-20 frames by description density
- `digest.txt` — compressed pass-2 outputs

### 1.4 Synthesis — ANALYSIS.md

Structure:
1. **TL;DR** — 1-line description + Pillar table + 1-sentence summary
2. **What X is** — narrative from transcript ∧ dense frames
3. **Architecture** — reconstructed from `schema`-kind frames
4. **Visual concepts** — palette, UI language, recurring metaphors
5. **Key frames gallery** — top N with timestamps + descriptions
6. **Open questions** — low-confidence items (◯)

**Cross-check rule:** every ◐ from frames — does transcript confirm? → promote to ★.

### 1.5 Companion page (optional)

| Output | Skill | Path |
|---|---|---|
| Long-form scroll onepage | `forge:forge-presentation` | `~/.roxabi/forge/<project>/visuals/<name>.html` |
| Slide deck | `forge:forge-slides` | `~/.roxabi/forge/<project>/slides/<name>.html` |
| Long-form multi-tab guide | `forge:forge-guide` | `~/.roxabi/forge/<project>/guide/` |
| Issue-linked analysis | `forge:forge-epic` | `~/.roxabi/forge/<project>/epic-<N>.html` |
| Render existing md as-is | `forge:forge-md` | `<input>.preview.html` |

**Default pick:** `forge:forge-presentation` — hero + §01..§N sections, scroll reveals, offline single-file. Use `forge-slides` only when building an actual slide deck for screen-share/live presentation.

---

## Phase 2 — Writing style (creator tone)

Extract *how* the creator speaks — register, fillers, FR/EN mix, sentence shape, signature tics.

**Input contract:** `transcript.md` **file path** (Phase 1.1 output). URL input is out-of-scope for this phase — transcript acquisition belongs to Phase 1.1 (`yt-dlp` captions or `web-intel:scrape`). Each phase has a single responsibility.

```bash
/voice-style ~/.roxabi/forge/<project>/transcript.md
```

| Skill | Status |
|---|---|
| `content-lab:voice-style` | shipped v1 (2026-04-20) — ⚠ currently also accepts URLs by invoking `web-intel:scraper.py`; scheduled to drop URL handling in v2 |
| manual notes from transcript | fallback today |

Output → **creator-style card** (~40–80 lines):

```
register:      casual / direct
fillers:       "en gros", "du coup", "globalement", "cool", "meuf"
code-switch:   FR→EN on tech terms (scale-up, track record, package)
sentence:      short, punchy · explains complex → simple
tone:          confident, assertive, conversational
moves:         analogy-first · friend-explaining framing
```

Stored → `~/.roxabi-vault/content-lab/voice-styles/<YYYY-MM-DD>_<slug>.md`

¬ use `brand-voice:*` (enterprise-scope, wrong tool).

---

## Phase 3 — Voice sample (clone)

### 3.1 Pick clean segment

| Case | Skill |
|---|---|
| YouTube source | [`voiceCLI:yt-clone`](~/projects/voiceCLI/skills/yt-clone/SKILL.md) |
| Local video / audio | `voiceCLI:sample-pick` + `voicecli samples add` |
| Invent personality | `voiceCLI:voice-design` |

**Clean-segment picker** (once `sample-pick` exists — currently manual `--start`/`--duration`):

```
VAD (silero-vad / webrtc-vad)  → speech-only windows
music / noise detector          → reject overlapping music
score: duration ≥ 15s · SNR high · pitch/energy near median
       · not in first/last 10% (skip intros/outros)
→ ranked top-N + preview MP3s
```

### 3.2 Import + set active

```bash
voicecli samples add <sample>.wav
voicecli samples use <sample>.wav
voicecli samples active          # verify
```

`yt-clone` does 3.1 + 3.2 + test clone in one shot.

---

## Phase 4 — Storyboard

Scene plan + timing + VO draft + visual direction.

Skill: [`video-engine:storyboard`](~/projects/roxabi-production/plugins/video-engine/skills/storyboard/SKILL.md)

Output → scene plan + `narration.md` draft.

---

## Phase 5 — VO render

`narration.md` (YAML frontmatter + per-segment directives) → WAV.

```markdown
---
language: French
engine: qwen-fast
segment_gap: 300
crossfade: 50
---

<!-- emotion: "Calm, mysterious" -->
First line.

<!-- emotion: "Excited" -->
Second line.
```

**Per-segment directives:** `emotion` · `speed` · `accent` · `personality` · `language` · `segment_gap` · `crossfade`

| Skill | When |
|---|---|
| [`video-engine:voice-over`](~/projects/roxabi-production/plugins/video-engine/skills/voice-over/SKILL.md) | integrated in video project |
| [`voiceCLI:voice`](~/projects/voiceCLI/skills/voice/SKILL.md) | standalone (`voicecli clone narration.md -o narration.wav`) |

**Engine choice:**

| Engine | Best for |
|---|---|
| `qwen-fast` | free-form emotion · multilingual · 5–9× faster (CUDA graph) |
| `qwen` | same as fast, no CUDA-graph overhead |
| `chatterbox` | multilingual clone · exaggeration control |

**VRAM guard** (RTX 3080 10GB): TTS daemon ~7.4GB + STT ~2.2GB → clone OOMs. `yt-clone` auto-stops STT; manual path:

```bash
make -C ~/projects stt stop
voicecli clone narration.md -e qwen-fast
make -C ~/projects stt start
```

---

## Phase 6 — Compose

TSX scaffold using kit components.

Skill: [`video-engine:compose`](~/projects/roxabi-production/plugins/video-engine/skills/compose/SKILL.md)

Alt: copy existing `roxabi-production/showcase/*.tsx` (e.g. `lyra-trailer-vo.md`-adjacent).

Output → `showcase/<name>.tsx` + registered ∈ `dev/main.tsx`.

**Preview:** `npm run dev` → `http://localhost:3002?composition=<id>`

---

## Phase 7 — Soundtrack (light)

VO + **light** BGM + minimal SFX.

Skill: [`video-engine:soundtrack`](~/projects/roxabi-production/plugins/video-engine/skills/soundtrack/SKILL.md)

```bash
npm run render <id> out/<name>.mp4 \
  --audio=narration.wav \
  --bgm=ambient.mp3:vol=0.15 \      # light
  --sfx=t=2.5:file=whoosh.mp3:vol=0.6
```

---

## Phase 8 — Render

MP4 via Puppeteer + FFmpeg.

Skill: [`video-engine:render`](~/projects/roxabi-production/plugins/video-engine/skills/render/SKILL.md)

```bash
npm run render <id> out/<name>.mp4 --audio=assets/audio/<name>/narration.wav
```

Or end-to-end: [`video-engine:produce`](~/projects/roxabi-production/plugins/video-engine/skills/produce/SKILL.md) = storyboard → compose → vo → soundtrack → render.

---

## Phase 9 — Companion page

Same forge skills as [§ 1.5](#15-companion-page-optional) — now for the **final artifact** (press page, analysis, landing).

---

## Decision forks

```
reference type?
├── narrative / script            ─▶  content-lab:video-recipe
├── visuals / style               ─▶  web-intel:video-analyze   (Phase 1.2)
├── recreate components           ─▶  video-engine:reverse-engineer
└── concept / article URL         ─▶  web-intel:explain          (custom prompt)

voice source?
├── YouTube URL                   ─▶  voiceCLI:yt-clone         (one-shot)
├── local video / audio file      ─▶  voiceCLI:sample-pick + voice
└── no source (invent)            ─▶  voiceCLI:voice-design

companion page?
├── scroll onepage (default)      ─▶  forge:forge-presentation
├── slide deck (live/screen-share)─▶  forge:forge-slides
├── long-form multi-tab guide     ─▶  forge:forge-guide
├── issue-linked breakdown        ─▶  forge:forge-epic
└── render existing markdown      ─▶  forge:forge-md
```

---

## Skills & playbooks referenced

| Phase | Skill / playbook | Repo |
|---|---|---|
| 0 | `dev-core:frame` | `roxabi-plugins` |
| 1.1 | `yt-dlp` · `voiceCLI:voice` (transcribe) | ext · `voiceCLI` |
| 1.2 | `web-intel:video-analyze` | `roxabi-plugins` |
| 1.5 / 9 | `forge:forge-{slides,guide,epic,md}` | `roxabi-forge` |
| 2 | `content-lab:voice-style` | `roxabi-plugins` |
| 3 | `voiceCLI:yt-clone` · `voiceCLI:voice` · `voiceCLI:voice-design` · `voiceCLI:sample-pick` | `voiceCLI` |
| 4 | `video-engine:storyboard` | `roxabi-production` |
| 5 | `video-engine:voice-over` · `voiceCLI:voice` | `roxabi-production` · `voiceCLI` |
| 6 | `video-engine:compose` | `roxabi-production` |
| 7 | `video-engine:soundtrack` | `roxabi-production` |
| 8 | `video-engine:render` · `video-engine:produce` | `roxabi-production` |

**Related playbooks:** `BRAND-EXPLORATION-PLAYBOOK.md` (not used here — enterprise scope) · `AVATAR-PLAYBOOK.md` (visual identity).

---

## File locations

| Component | Path |
|---|---|
| Video understanding output | `~/.roxabi/forge/<project>/` |
| Transcript | `~/.roxabi/forge/<project>/transcript.md` |
| VLM analysis | `~/.roxabi/forge/<project>/analysis.json` + `frames/` |
| Synthesis | `~/.roxabi/forge/<project>/ANALYSIS.md` |
| Voice samples | `~/.voicecli/TTS/samples/` |
| Narration scripts | `<project>/assets/audio/<name>/narration.md` |
| Generated speech | `~/.voicecli/TTS/voices_out/` |
| Video compositions | `roxabi-production/showcase/*.tsx` |
| Rendered videos | `roxabi-production/out/*.mp4` |
| Companion pages | `~/.roxabi/forge/<project>/*.html` |

---

## Dependencies

- `yt-dlp` · `ffmpeg` · `nvidia-smi`
- `llama-server` + VLM GGUF (Qwen3-VL-8B Q5_K_M + mmproj-BF16 — qaya config)
- `voicecli` (+ daemons: `tts`, `stt`)
- `roxabi-production` (React + Puppeteer + FFmpeg)
- `forge` (see `~/.claude/plugins/cache/roxabi-forge/`)

---

## VRAM choreography

Two services compete for GPU: **VLM** (Phase 1.2) and **TTS daemon** (Phase 5). STT should be stopped through the whole pipeline — not used anywhere. Compositor eats 0.5–6 GB and can't be moved.

**Per-phase plan (10 GB card — RTX 3080 prod):**

| Phase | VLM | TTS | STT | Command |
|---|---|---|---|---|
| 0 frame | — | — | — | — |
| 1.1 transcript | — | — | stop | `make stt stop` |
| 1.2 VLM analysis | **start** | **stop** | stop | `make tts stop && make stt stop && llama-server … :8093` |
| 1.3–1.4 derivatives + synthesis | idle | stop | stop | VLM can idle (no GPU load between requests) |
| 1.5 forge page | kill | — | — | `pkill -f llama-server` |
| 2 voice-style | — | — | — | CPU-only, no VRAM needed |
| 3 yt-clone / sample-pick | — | **start** | stop | `make tts start` (auto-stops STT if running) |
| 4 storyboard | — | — | — | CPU-only |
| 5 VO render (qwen-fast) | — | running | stop | `make stt stop && voicecli clone …` |
| 6–7 compose / soundtrack | — | — | — | CPU-only |
| 8 render MP4 | — | — | — | Puppeteer + FFmpeg, negligible VRAM |

**16 GB card (RTX 5070 Ti dev):** VLM + TTS daemon *can* coexist (7.4 + 7.5 = 14.9 GB) iff compositor < 1 GB. Otherwise treat like 10 GB card. Always stop STT regardless — it's never read in this pipeline.

**Diagnostics:**

```bash
nvidia-smi --query-gpu=memory.used,memory.free,memory.total --format=csv
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

If `memory.used` ≫ sum of listed compute apps, the delta is the graphics compositor — not killable without logout.

---

## Gaps

### Shipped v1 — 2026-04-20

| # | Skill | Purpose | Phase |
|---|---|---|---|
| 1 | `web-intel:explain` | scrape URL + LLM(custom prompt) — concept explainer · digest · steelman · compare | 1 (ref URL) |
| 2 | `content-lab:voice-style` | creator writing-style card from transcript | 2 |
| 3 | `voiceCLI:sample-pick` | silence-based VAD + scoring → ranked clean-speech segments | 3 |

### Open — surfaced by IndyDevDan M5 Max run (2026-04-21)

| # | Issue | Where | Fix |
|---|---|---|---|
| 1 | `qwen-fast` clone crashes on multi-segment narration with `<!-- emotion: -->` directives — `generate_voice_clone()` rejects `instruct` kwarg | `voiceCLI:src/voicecli/engines/qwen_fast.py:98` | Gate `kw["instruct"] = seg.instruct` on `method == "custom_voice"`; log WARNING at `clone()` entry when instruct present on fast; add `ENGINE_CAPS` flag in `translate.py` |
| 2 | `content-lab:voice-style` accepts URLs by shelling out to `web-intel:scraper.py` — cross-plugin coupling, duplicates Phase 1.1 responsibility | `content-lab/skills/voice-style/SKILL.md` step 3 | v2: accept file path only, error on URL with "run Phase 1.1 first" |
| 3 | `/video-analyze` preflight had no "how to start the VLM" guidance; VRAM contention between VLM and TTS daemon not documented | playbook Phase 1.2 | **fixed** — Preflight block + VRAM choreography table added |

---

## Precedents

| Project | Path | Notes |
|---|---|---|
| Qaya³ analysis | `~/.roxabi/forge/qaya-analysis/` | PLAN + VLM + OCR (no transcript — flagged gap) |
| Lyra trailer | `roxabi-production/showcase/lyra-trailer-vo.md` + `out/lyra-trailer-vo-*.{wav,mp3}` | voice clone + VO + render |
