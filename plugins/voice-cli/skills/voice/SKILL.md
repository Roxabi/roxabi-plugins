---
name: voice
description: 'VoiceCLI assistant — author TTS scripts, generate speech, clone voices, transcribe audio, manage samples. Knows engine capabilities, markdown format, and all CLI commands. Triggers: "voice" | "voicecli" | "speech" | "generate speech" | "clone voice" | "transcribe" | "TTS" | "text to speech" | "voice script".'
version: 0.4.0
allowed-tools: Read, Edit, Write, Bash, Glob, Grep, AskUserQuestion
---

# VoiceCLI — Unified Voice Assistant

**Purpose**: Author TTS markdown scripts, run voicecli CLI commands, manage the full voice pipeline.

VoiceCLI is a Python CLI for local voice generation (TTS) and transcription (STT) with multiple AI backends.

## Auto-Discovery

Before the **first** command in a session, determine how to invoke voicecli:

```bash
# 1. Preferred: voicecli in PATH (installed via `voicecli init`)
if command -v voicecli &>/dev/null; then
  echo "voicecli is in PATH — use it directly"
# 2. Fallback: find project dir and use uv run
else
  if [ -n "$VOICECLI_DIR" ] && [ -f "$VOICECLI_DIR/src/voicecli/cli.py" ]; then
    true  # already set via env var
  else
    for d in . .. ../voiceCLI ~/projects/voiceCLI; do
      test -f "$d/src/voicecli/cli.py" && VOICECLI_DIR="$(cd "$d" && pwd)" && break
    done
  fi
  [ -z "$VOICECLI_DIR" ] && echo "voiceCLI not found — run 'voicecli init' or set VOICECLI_DIR" && exit 1
  echo "Using fallback: cd $VOICECLI_DIR && uv run voicecli"
fi
```

Cache the result for the session:
- **If in PATH**: use `voicecli <args>` directly (works from any directory)
- **Fallback**: use `cd "$VOICECLI_DIR" && uv run voicecli <args>`

All examples below use `voicecli` — substitute with the fallback form if needed.

## First Use

On the **first invocation** of any voice/TTS command in a session, proceed directly with the request.

> `voicecli doctor` is a **diagnostic/installation tool** — only run it when the user explicitly asks for a system check or when troubleshooting an error. Never run it automatically.

## Engine Capability Matrix

Four engines with different strengths. Pick based on user intent:

| Capability | Qwen | Qwen-Fast | Chatterbox Multilingual | Chatterbox Turbo |
|------------|------|-----------|-------------------------|------------------|
| instruct (free-form emotion) | **yes** | **yes** | no | no |
| segments (per-section overrides) | **yes** | **yes** | **yes** | **yes** |
| paralinguistic tags | to_instruct | to_instruct | strip | **native** |
| exaggeration (0.25–2.0) | no | no | **yes** (per-segment) | **yes** (per-segment) |
| cfg_weight (0.0–1.0) | no | no | **yes** (per-segment) | **yes** (per-segment) |
| language (23 langs) | **yes** (per-segment) | **yes** (per-segment) | **yes** (per-segment) | no (EN only) |
| built-in voices (9) | **yes** (per-segment) | **yes** (per-segment) | no | no |
| CUDA graph acceleration | no | **yes** (5-9x speedup) | no | no |

### Engine Selection Guide

| User wants… | Engine |
|-------------|--------|
| Multi-language + voice cloning | `chatterbox` |
| English + emotion tags ([laugh], [sigh]) | `chatterbox-turbo` |
| Free-form emotion instructions | `qwen` or `qwen-fast` |
| Named built-in voices | `qwen` or `qwen-fast` |
| Per-section emotion changes | `qwen` or `qwen-fast` |
| Per-section expressiveness | `chatterbox` or `chatterbox-turbo` |
| Bilingual content (language switching) | `qwen`, `qwen-fast`, or `chatterbox` |
| Fastest generation (CUDA graph accel.) | `qwen-fast` |

### Tag Handling

Tags: `[laugh]` `[chuckle]` `[cough]` `[sigh]` `[gasp]` `[groan]` `[sniff]` `[shush]` `[clear throat]`

- **Turbo**: tags kept in text, engine processes them natively
- **Qwen**: tags split into segments with mapped instruct (e.g. `[laugh]` → `instruct: "Laughing"`)
- **Multilingual**: tags stripped (use exaggeration/cfg_weight instead)

The code translator handles this automatically — write tags in the universal format.

### Qwen Voices

Vivian, Serena, Uncle_Fu, Dylan, Eric, Ryan (default), Aiden, Ono_Anna, Sohee

## User Config (`voicecli.toml`)

Optional file at project root for default settings:

```toml
[defaults]
language = "French"
engine = "qwen"
accent = "Léger accent du sud provençal"
personality = "Voix calme, douce et flamboyante"
exaggeration = 0.7
cfg_weight = 0.3
segment_gap = 200
crossfade = 50
```

Structured instruct parts (`accent`, `personality`, `speed`, `emotion`) auto-compose into `instruct`.
Raw `instruct` bypasses composition. **Write instruct parts in the target language.**

**Segment propagation**: toml structured parts are backfilled into `.md` segments where frontmatter didn't set them, so a script with no frontmatter still inherits instruct from voicecli.toml.

Priority: **CLI flag > markdown frontmatter > voicecli.toml > hardcoded default**

## Unified Markdown Format

One `.md` file works across all engines — the code translator adapts per engine.

### Frontmatter (all optional)

```yaml
---
language: French          # language name (Qwen + Chatterbox Multilingual)
voice: Ryan               # built-in voice (Qwen only)
engine: qwen              # qwen | qwen-fast | chatterbox | chatterbox-turbo
accent: "Provençal"       # pronunciation/origin (Qwen, composes into instruct)
personality: "Calme"      # character traits (Qwen, composes into instruct)
speed: "Rythme posé"      # tempo/pace (Qwen, composes into instruct)
emotion: "Chaleureuse"    # emotional state (Qwen, composes into instruct)
instruct: "Parle avec colère" # raw instruct bypass (overrides structured parts)
exaggeration: 0.75        # expressiveness 0.25-2.0 (Chatterbox only)
cfg_weight: 0.3           # speaker adherence 0.0-1.0 (Chatterbox only)
segment_gap: 200          # ms silence between segments (default 0)
crossfade: 50             # ms fade between segments (default 0)
---
```

### Per-Section Directives

All frontmatter fields can be overridden per-section using `<!-- key: value -->` comments.
Multiple keys can be combined in a single comment: `<!-- emotion: "Passionnée", speed: "Rapide" -->`.
Directives accumulate before a text block and apply to the text that follows.
Each section inherits frontmatter defaults, overridden by its inline directives.
Commas inside quoted values are safe: `<!-- emotion: "Passionnée, mais contenue" -->`.

Available: `accent`, `personality`, `speed`, `emotion`, `instruct`, `exaggeration`, `cfg_weight`, `language`, `voice`, `segment_gap`, `crossfade`

### Segment Transitions

| gap | crossfade | Result |
|-----|-----------|--------|
| 0   | 0         | Direct concat (default) |
| >0  | 0         | Hard cut, silence, hard cut |
| 0   | >0        | Fade-out then fade-in (no silence) |
| >0  | >0        | Fade-out, silence, fade-in |

### Body Features

- Standard markdown (auto-stripped to plain text)
- `<!-- emotion: "Passionnée", speed: "Rapide" -->` — multi-key on one line (preferred)
- `<!-- accent: "Parisien" -->` — single-key still works
- `<!-- instruct: "Speak seriously" -->` — raw instruct bypass (Qwen)
- `<!-- exaggeration: 0.8, cfg_weight: 0.3 -->` — per-section expressiveness (Chatterbox)
- `<!-- language: Japanese, voice: Ono_Anna -->` — per-section language + voice switch
- `<!-- segment_gap: 500, crossfade: 100 -->` — per-section transition control
- `[laugh]` `[sigh]` etc. — paralinguistic tags (see tag handling above)

### Example Script

```markdown
---
language: French
accent: "Léger accent provençal"
personality: "Calme et douce"
emotion: "Chaleureuse"
exaggeration: 0.7
cfg_weight: 0.3
segment_gap: 200
---

Welcome everyone. [laugh] This is going to be fun!

<!-- emotion: "Passionnée", segment_gap: 500 -->
Now let me tell you something important. [sigh] It has been a long road.

<!-- language: Japanese, voice: Ono_Anna, crossfade: 100, segment_gap: 0 -->
A section in Japanese with a different voice, crossfaded in.
```

### Recommended Settings

- Passionate speech: exaggeration 0.7–0.8, cfg_weight 0.3
- Cross-language cloning: cfg_weight 0.0 (reduces accent bleed)
- Default: exaggeration 0.5, cfg_weight 0.5
- Natural pauses between sections: segment_gap 200–300

## CLI Commands Reference

### Generate (built-in voices)

```bash
voicecli generate "Hello world"                       # Qwen, default voice
voicecli generate "Bonjour" -e chatterbox --lang French
voicecli generate "text" -e chatterbox-turbo          # English + tags
voicecli generate "text" -e qwen-fast                 # CUDA-accelerated Qwen
voicecli generate script.md                           # from markdown
voicecli generate script.md --mp3                     # + MP3 output
voicecli generate "text" -v Ono_Anna --lang Japanese  # specific voice
voicecli generate script.md --segment-gap 300         # 300ms between segments
voicecli generate script.md --crossfade 50            # 50ms fade transitions
voicecli generate "text" --fast                       # 0.6B model (faster, lower quality)
voicecli generate "Long text" --chunked               # progressive output (separate files)
voicecli generate "Long text" --chunked --chunk-size 300  # smaller chunks (~20s each)
```

### Clone (voice cloning)

```bash
voicecli clone "text" --ref voice.wav                 # clone from audio
voicecli clone "text"                                 # uses active sample
voicecli clone script.md --mp3                        # from markdown + MP3
voicecli clone "text" -e chatterbox --lang French     # multilingual clone
voicecli clone "text" -e qwen-fast                    # CUDA-accelerated clone
voicecli clone script.md --segment-gap 200            # with segment transitions
voicecli clone "text" --fast                          # 0.6B model (faster, lower quality)
voicecli clone "Long text" --chunked                  # progressive output (separate files)
```

### Transcribe (speech-to-text)

```bash
voicecli transcribe audio.wav                         # default model
voicecli transcribe audio.wav --json                  # JSON + timestamps
voicecli transcribe audio.wav -m large-v3             # specific model
voicecli transcribe audio.wav -l fr                   # force language
```

Models: tiny, base, small, medium, large-v3, large-v3-turbo (default)

### Listen (real-time mic STT)

```bash
voicecli listen                                       # Kyutai 1b (EN+FR)
voicecli listen -m 2.6b                               # EN-only, higher quality
```

### Samples

```bash
voicecli samples list                                 # list all samples
voicecli samples add file.wav                         # import WAV
voicecli samples record name -d 30                    # record 30s from mic
voicecli samples use name.wav                         # set active for clone
voicecli samples active                               # show current active
voicecli samples remove name.wav                      # delete sample
```

### Utilities

```bash
voicecli mp3 TTS/voices_out/file.wav                  # WAV → MP3 (192kbps)
voicecli mp3 TTS/voices_out/file.wav -b 320           # 320kbps
voicecli voices                                       # list Qwen voices
voicecli voices -e chatterbox                         # list engine voices
voicecli engines                                      # list engines
voicecli emotions                                     # emotion cheat sheet
voicecli doctor                                       # system readiness check
voicecli init                                         # create starter voicecli.toml
```

## Project Layout

```
TTS/
  texts_in/       — authored .md scripts (git-tracked)
  voices_out/     — generated WAV/MP3 (gitignored)
  samples/        — voice samples for cloning (gitignored)
STT/
  audio_in/       — audio files to transcribe (gitignored)
  texts_out/      — transcription results (gitignored)
```

## Chunked Output

Use `--chunked` for long texts to enable progressive sending via Telegram. Each chunk is saved as a separate numbered file (`prefix_001.wav`, `prefix_002.wav`...) and a `.done` sentinel is written when complete.

- For plain text: splits at paragraph/sentence boundaries (~500 chars per chunk by default)
- For .md scripts with segments: each segment becomes a chunk
- `--chunk-size N` adjusts target chunk size in characters (~15 chars/sec of speech)

**Always use `--chunked` when generating from Telegram** so the bot can send audio progressively.

Output format is WAV by default. Do NOT add `--mp3` unless the user explicitly asks for it.

## Workflow

### Intent → Action Mapping

1. **User wants to create a speech** → Author a `.md` script in `TTS/texts_in/`, then run `generate` (default) or `clone` (only if explicitly requested)
2. **User wants quick speech** → Run `generate` with inline text
3. **User explicitly wants voice cloning** → Ensure sample exists (`samples list`/`samples add`), then `clone`. Never default to `clone` — the presence of an active sample does NOT imply the user wants cloning.
4. **User wants to transcribe** → Run `transcribe` on audio file
5. **User wants to edit a script** → Read existing `.md`, apply changes respecting the format
6. **User asks about capabilities** → Consult engine matrix, recommend engine

### Script Authoring Rules

**Before writing any script**, read `voicecli.toml` to discover the user's configured defaults (engine, language, accent, personality, etc.). Only add frontmatter fields that **override** those defaults — never duplicate what toml already sets.

When writing `.md` scripts:

1. Use all features freely — the translator adapts per engine (unsupported fields are nulled per-segment)
2. Use `<!-- key: value, key2: value2 -->` directives for per-section overrides — combine multiple keys on one line (accent, personality, speed, emotion, instruct, exaggeration, language, voice, segment_gap, crossfade)
3. Place `[tags]` naturally in the text flow — before or after the relevant phrase
4. Keep text segments under ~250 chars for Chatterbox engines (they chunk at sentence boundaries, but shorter is safer)
5. For multilingual content, set `language:` in frontmatter and override per-section with `<!-- language: ... -->`
6. Scripts go in `TTS/texts_in/` by convention
7. Use `segment_gap` and `crossfade` in frontmatter for global defaults, override per-section for fine control
8. Write all instruct parts (accent, personality, speed, emotion, instruct) in the target language

### Telegram Integration

When running inside the 2ndBrain Telegram bot, voice files auto-send to the user's chat after generation. **Always use `--chunked`** so the bot can send audio progressively. Skip `send_voice_telegram.py` — just generate with `--chunked` and report what you created.

### Key Constraints

- Qwen clone does NOT support instruct — only generate does
- Chatterbox Turbo is English-only
- Chatterbox Multilingual strips all paralinguistic tags
- Both Chatterbox engines have a ~40s generation cutoff (handled by auto-chunking per segment)
- Clone falls back to active sample when `--ref` is omitted
- `qwen-fast` has same capabilities as `qwen` but uses CUDA graph acceleration (5-9x speedup after warmup)
- `--fast` flag uses the smaller 0.6B model (Qwen/Qwen-fast only) — faster but lower quality
- Base instruct is preserved in tag-split segments (e.g. `[laugh]` on Qwen keeps the original instruct alongside the tag instruct)

$ARGUMENTS
