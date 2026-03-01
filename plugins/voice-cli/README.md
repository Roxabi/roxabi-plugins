# voice-cli

Claude Code plugin for [VoiceCLI](https://github.com/Roxabi/voiceCLI) — local AI voice generation and transcription.

## What It Does

Gives Claude Code deep knowledge of the VoiceCLI CLI so it can:

- **Author TTS scripts** — write markdown files with correct frontmatter, per-section emotions, paralinguistic tags, and engine-appropriate settings
- **Run voice commands** — generate speech, clone voices, transcribe audio, manage samples
- **Pick the right engine** — knows the full capability matrix (Qwen, Qwen-Fast, Chatterbox Multilingual, Turbo) and recommends the best fit
- **Chunked output** — progressive audio generation for long texts and Telegram integration
- **Daemon mode** — start `voicecli serve` to keep models warm; subsequent generates run in ~2–5s instead of ~60s
- **Manage the workflow** — samples, output formats, language settings, expressiveness controls

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install voice-cli
```

## Usage

Trigger phrases:

- "write me a voice script for a French speech"
- "generate speech from this text"
- "clone my voice saying this"
- "transcribe this audio file"
- "which engine should I use for Japanese?"
- "list my voice samples"

## When to Use

- Writing TTS markdown scripts with emotional segments and paralinguistic tags
- Running voicecli commands without memorizing flags and engine differences
- Choosing between Qwen, Qwen-Fast, Chatterbox Multilingual, and Chatterbox Turbo
- Generating long texts with chunked progressive output
- Starting or querying the daemon for warm-model fast generation
- Managing voice samples and cloning workflows
- Transcribing audio files or doing real-time speech-to-text

## How It Works

The plugin embeds the full VoiceCLI knowledge base: engine capability matrix, unified markdown format, CLI command reference, and workflow patterns. When triggered, Claude auto-discovers the voiceCLI project directory and operates from there.

The plugin does not include the AI models — those live in the voiceCLI project. It provides the intelligence layer that lets Claude Code drive the VoiceCLI CLI effectively.

## Engines at a Glance

| Engine | Best For |
|--------|----------|
| Qwen | Free-form emotion instructions, per-section changes, 9 built-in voices |
| Qwen-Fast | Same as Qwen with CUDA graph acceleration (5-9x speedup) |
| Chatterbox Multilingual | 23 languages, voice cloning across languages |
| Chatterbox Turbo | English with native paralinguistic tags ([laugh], [sigh], etc.) |

## Requirements

- [VoiceCLI](https://github.com/Roxabi/voiceCLI) installed locally
- Python 3.12 + uv
- GPU with CUDA support (for model inference)
