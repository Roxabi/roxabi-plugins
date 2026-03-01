---
name: voice
description: 'VoiceMe assistant — author TTS scripts, generate speech, clone voices, transcribe audio, manage samples. Knows engine capabilities, markdown format, and all CLI commands. Triggers: "voice" | "voiceme" | "speech" | "generate speech" | "clone voice" | "transcribe" | "TTS" | "text to speech" | "voice script".'
version: 0.2.0
allowed-tools: Read, Edit, Write, Bash, Glob, Grep, AskUserQuestion
---

# VoiceMe — Unified Voice Assistant

**Purpose**: Author TTS markdown scripts, run voiceme CLI commands, manage the full voice pipeline.

VoiceMe is a Python CLI (`uv run voiceme`) for local voice generation (TTS) and transcription (STT) with multiple AI backends.

## Auto-Discovery

Before any action, detect voiceMe project location:

```bash
# Check VOICEME_DIR env var first, then search common locations
if [ -n "$VOICEME_DIR" ] && [ -f "$VOICEME_DIR/src/voiceme/cli.py" ]; then
  echo "VOICEME_DIR=$VOICEME_DIR"
else
  for d in . .. ../voiceMe ~/projects/voiceMe; do
    test -f "$d/src/voiceme/cli.py" && echo "VOICEME_DIR=$(cd "$d" && pwd)" && break
  done
fi
```

If not found → inform user voiceMe is not installed and offer guidance.

All `uv run voiceme` commands must run from the voiceMe project directory.

## First Use

On the **first invocation** of any voice/TTS command in a session:

1. Run `cd $VOICEME_DIR && uv run voiceme doctor` to check system readiness
2. If doctor reports issues (missing CUDA, no models downloaded), guide the user through fixes before attempting generation
3. Skip this check on subsequent invocations in the same session, or when the user is asking informational questions (engine capabilities, script format, etc.)

## Engine Capability Matrix

Three engines with different strengths. Pick based on user intent:

| Capability | Qwen | Chatterbox Multilingual | Chatterbox Turbo |
|------------|------|-------------------------|------------------|
| instruct (free-form emotion) | **yes** | no | no |
| segments (per-section overrides) | **yes** | **yes** | **yes** |
| paralinguistic tags | to_instruct | strip | **native** |
| exaggeration (0.25–2.0) | no | **yes** (per-segment) | **yes** (per-segment) |
| cfg_weight (0.0–1.0) | no | **yes** (per-segment) | **yes** (per-segment) |
| language (23 langs) | **yes** (per-segment) | **yes** (per-segment) | no (EN only) |
| built-in voices (9) | **yes** (per-segment) | no | no |

### Engine Selection Guide

| User wants… | Engine |
|-------------|--------|
| Multi-language + voice cloning | `chatterbox` |
| English + emotion tags ([laugh], [sigh]) | `chatterbox-turbo` |
| Free-form emotion instructions | `qwen` |
| Named built-in voices | `qwen` |
| Per-section emotion changes | `qwen` |
| Per-section expressiveness | `chatterbox` or `chatterbox-turbo` |
| Bilingual content (language switching) | `qwen` or `chatterbox` |

### Tag Handling

Tags: `[laugh]` `[chuckle]` `[cough]` `[sigh]` `[gasp]` `[groan]` `[sniff]` `[shush]` `[clear throat]`

- **Turbo**: tags kept in text, engine processes them natively
- **Qwen**: tags split into segments with mapped instruct (e.g. `[laugh]` → `instruct: "Laughing"`)
- **Multilingual**: tags stripped (use exaggeration/cfg_weight instead)

The code translator handles this automatically — write tags in the universal format.

### Qwen Voices

Vivian, Serena, Uncle_Fu, Dylan, Eric, Ryan (default), Aiden, Ono_Anna, Sohee

## User Config (`voiceme.toml`)

Optional file at project root for default settings:

```toml
[defaults]
language = "French"
engine = "chatterbox"
exaggeration = 0.7
cfg_weight = 0.3
segment_gap = 200
crossfade = 50
```

Priority: **CLI flag > markdown frontmatter > voiceme.toml > hardcoded default**

## Unified Markdown Format

One `.md` file works across all engines — the code translator adapts per engine.

### Frontmatter (all optional)

```yaml
---
language: French          # language name (Qwen + Chatterbox Multilingual)
voice: Ryan               # built-in voice (Qwen only)
engine: qwen              # qwen | chatterbox | chatterbox-turbo
instruct: "Speak angrily" # free-form emotion (Qwen only)
exaggeration: 0.75        # expressiveness 0.25-2.0 (Chatterbox only)
cfg_weight: 0.3           # speaker adherence 0.0-1.0 (Chatterbox only)
segment_gap: 200          # ms silence between segments (default 0)
crossfade: 50             # ms fade between segments (default 0)
---
```

### Per-Section Directives

All frontmatter fields can be overridden per-section using `<!-- key: value -->` comments.
Directives accumulate before a text block and apply to the text that follows.
Each section inherits frontmatter defaults, overridden by its inline directives.

Available: `instruct`, `exaggeration`, `cfg_weight`, `language`, `voice`, `segment_gap`, `crossfade`

### Segment Transitions

| gap | crossfade | Result |
|-----|-----------|--------|
| 0   | 0         | Direct concat (default) |
| >0  | 0         | Hard cut, silence, hard cut |
| 0   | >0        | Fade-out then fade-in (no silence) |
| >0  | >0        | Fade-out, silence, fade-in |

### Body Features

- Standard markdown (auto-stripped to plain text)
- `<!-- instruct: "Speak seriously" -->` — per-section emotion (Qwen)
- `<!-- exaggeration: 0.8 -->` — per-section expressiveness (Chatterbox)
- `<!-- language: Japanese -->` — per-section language switch
- `<!-- voice: Ono_Anna -->` — per-section voice switch (Qwen)
- `<!-- segment_gap: 500 -->` — silence before this section (ms)
- `<!-- crossfade: 100 -->` — fade before this section (ms)
- `[laugh]` `[sigh]` etc. — paralinguistic tags (see tag handling above)

### Example Script

```markdown
---
language: French
instruct: "Speak warmly"
exaggeration: 0.7
cfg_weight: 0.3
segment_gap: 200
---

Welcome everyone. [laugh] This is going to be fun!

<!-- instruct: "Speak seriously" -->
<!-- segment_gap: 500 -->
Now let me tell you something important. [sigh] It has been a long road.

<!-- language: Japanese -->
<!-- voice: Ono_Anna -->
<!-- crossfade: 100 -->
<!-- segment_gap: 0 -->
A section in Japanese with a different voice, crossfaded in.
```

### Recommended Settings

- Passionate speech: exaggeration 0.7–0.8, cfg_weight 0.3
- Cross-language cloning: cfg_weight 0.0 (reduces accent bleed)
- Default: exaggeration 0.5, cfg_weight 0.5
- Natural pauses between sections: segment_gap 200–300

## CLI Commands Reference

All commands use `uv run voiceme` from the voiceMe project directory.

### Generate (built-in voices)

```bash
uv run voiceme generate "Hello world"                       # Qwen, default voice
uv run voiceme generate "Bonjour" -e chatterbox --lang French
uv run voiceme generate "text" -e chatterbox-turbo          # English + tags
uv run voiceme generate script.md                           # from markdown
uv run voiceme generate script.md --mp3                     # + MP3 output
uv run voiceme generate "text" -v Ono_Anna --lang Japanese  # specific voice
uv run voiceme generate script.md --segment-gap 300         # 300ms between segments
uv run voiceme generate script.md --crossfade 50            # 50ms fade transitions
```

### Clone (voice cloning)

```bash
uv run voiceme clone "text" --ref voice.wav                 # clone from audio
uv run voiceme clone "text"                                 # uses active sample
uv run voiceme clone script.md --mp3                        # from markdown + MP3
uv run voiceme clone "text" -e chatterbox --lang French     # multilingual clone
uv run voiceme clone script.md --segment-gap 200            # with segment transitions
```

### Transcribe (speech-to-text)

```bash
uv run voiceme transcribe audio.wav                         # default model
uv run voiceme transcribe audio.wav --json                  # JSON + timestamps
uv run voiceme transcribe audio.wav -m large-v3             # specific model
uv run voiceme transcribe audio.wav -l fr                   # force language
```

Models: tiny, base, small, medium, large-v3, large-v3-turbo (default)

### Listen (real-time mic STT)

```bash
uv run voiceme listen                                       # Kyutai 1b (EN+FR)
uv run voiceme listen -m 2.6b                               # EN-only, higher quality
```

### Samples

```bash
uv run voiceme samples list                                 # list all samples
uv run voiceme samples add file.wav                         # import WAV
uv run voiceme samples record name -d 30                    # record 30s from mic
uv run voiceme samples use name.wav                         # set active for clone
uv run voiceme samples active                               # show current active
uv run voiceme samples remove name.wav                      # delete sample
```

### Utilities

```bash
uv run voiceme mp3 TTS/voices_out/file.wav                  # WAV → MP3 (192kbps)
uv run voiceme mp3 TTS/voices_out/file.wav -b 320           # 320kbps
uv run voiceme voices                                       # list Qwen voices
uv run voiceme voices -e chatterbox                         # list engine voices
uv run voiceme engines                                      # list engines
uv run voiceme emotions                                     # emotion cheat sheet
uv run voiceme doctor                                       # system readiness check
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

## Workflow

### Intent → Action Mapping

1. **User wants to create a speech** → Author a `.md` script in `TTS/texts_in/`, then run `generate` or `clone`
2. **User wants quick speech** → Run `generate` with inline text
3. **User wants voice cloning** → Ensure sample exists (`samples list`/`samples add`), then `clone`
4. **User wants to transcribe** → Run `transcribe` on audio file
5. **User wants to edit a script** → Read existing `.md`, apply changes respecting the format
6. **User asks about capabilities** → Consult engine matrix, recommend engine

### Script Authoring Rules

When writing `.md` scripts:

1. Use all features freely — the translator adapts per engine (unsupported fields are nulled per-segment)
2. Use `<!-- key: value -->` directives for per-section overrides (instruct, exaggeration, language, voice, segment_gap, crossfade)
3. Place `[tags]` naturally in the text flow — before or after the relevant phrase
4. Keep text segments under ~250 chars for Chatterbox engines (they chunk at sentence boundaries, but shorter is safer)
5. For multilingual content, set `language:` in frontmatter and override per-section with `<!-- language: ... -->`
6. Scripts go in `TTS/texts_in/` by convention
7. Use `segment_gap` and `crossfade` in frontmatter for global defaults, override per-section for fine control

### Key Constraints

- Qwen clone does NOT support instruct — only generate does
- Chatterbox Turbo is English-only
- Chatterbox Multilingual strips all paralinguistic tags
- Both Chatterbox engines have a ~40s generation cutoff (handled by auto-chunking per segment)
- Priority: CLI flag > markdown frontmatter > voiceme.toml > hardcoded default
- Clone falls back to active sample when `--ref` is omitted

$ARGUMENTS
