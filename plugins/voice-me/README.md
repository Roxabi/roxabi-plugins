# voice-me

Claude Code plugin for [VoiceMe](https://github.com/Roxabi/voiceMe) — local AI voice generation and transcription.

## What It Does

Gives Claude Code deep knowledge of the VoiceMe CLI so it can:

- **Author TTS scripts** — write markdown files with correct frontmatter, per-section emotions, paralinguistic tags, and engine-appropriate settings
- **Run voice commands** — generate speech, clone voices, transcribe audio, manage samples
- **Pick the right engine** — knows the full capability matrix (Qwen vs Chatterbox Multilingual vs Turbo) and recommends the best fit
- **Manage the workflow** — samples, output formats, language settings, expressiveness controls

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install voice-me
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
- Running voiceme commands without memorizing flags and engine differences
- Choosing between Qwen, Chatterbox Multilingual, and Chatterbox Turbo
- Managing voice samples and cloning workflows
- Transcribing audio files or doing real-time speech-to-text

## How It Works

The plugin embeds the full VoiceMe knowledge base: engine capability matrix, unified markdown format, CLI command reference, and workflow patterns. When triggered, Claude auto-discovers the voiceMe project directory and operates from there.

The plugin does not include the AI models — those live in the voiceMe project. It provides the intelligence layer that lets Claude Code drive the voiceMe CLI effectively.

## Engines at a Glance

| Engine | Best For |
|--------|----------|
| Qwen | Free-form emotion instructions, per-section changes, 9 built-in voices |
| Chatterbox Multilingual | 23 languages, voice cloning across languages |
| Chatterbox Turbo | English with native paralinguistic tags ([laugh], [sigh], etc.) |

## Requirements

- [VoiceMe](https://github.com/Roxabi/voiceMe) installed locally
- Python 3.12 + uv
- GPU with CUDA support (for model inference)
