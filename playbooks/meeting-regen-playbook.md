---
title: Meeting Regen Playbook
description: Regenerate audio from compressed screen recordings via voice cloning
purpose: Recover usable audio from recordings with good audio but unusable video
scope: Compressed screen recordings (OBS, Zoom, etc.) with exploitable audio track
dependencies:
  - voiceCLI (transcription, voice cloning)
  - Whisper (large-v3 model)
  - pyannote-audio (diarization)
  - ffmpeg
tags:
  - audio
  - transcription
  - voice-clone
  - meeting
  - screen-recording
version: "1.0"
last_updated: "2026-04-28"
---

# Meeting Regen — Playbook

**Objectif** : Regénérer l'audio d'un screen recording OBS (87 min, 2026-03-27) dont la vidéo est trop compressée (783 kb/s H.264) mais l'audio est exploitable (192 kbps AAC stéréo).

**Approche** : Transcrire → diariser → cloner les voix → réassembler avec sync (option C).

## Fichiers

| Fichier | Rôle |
|---------|------|
| `~/2026-03-27 13-06-21.mp4` | Source originale |
| `~/meeting_test/first_5min.wav` | Extrait 5 min (test) |
| `~/meeting_test/transcript_5min.json` | Transcription Whisper large-v3 (segments + timestamps) |
| `~/.voicecli/TTS/samples/mickael.wav` | Sample voix Mickaël (32s, trimmed) |
| `~/meeting_test/clone_*.wav` | Tests de clonage (voir galerie) |

## Pipeline validée

```
1. ffmpeg -i source.mp4 -vn -ar 16000 -ac 1 -acodec pcm_s16le audio.wav
2. voicecli transcribe audio.wav --model large-v3 --json -o transcript.json
3. [A FAIRE] Diarization pyannote → speaker_id par segment
4. [A FAIRE] Correction manuelle du transcript
5. voicecli samples record mickael -d 35  (fait, trimmed à 32s)
6. voicecli clone texte.md --engine <TBD> --ref sample.wav -o output.wav
7. [A FAIRE] Script assemblage avec sync option C
8. ffmpeg -i original.mp4 -i regen_audio.wav -c:v copy -map 0:v -map 1:a output.mp4
```

## Stratégie de synchronisation — Option C (hybride)

- Silences adaptatifs : chaque segment TTS calé sur le timestamp original
- Si le TTS est plus court → gap plus long avant le suivant
- Si le TTS déborde → time-stretch max 15% (rubberband/ffmpeg atempo)
- Au-delà de 15% → accepter micro-décalage, recaler au prochain silence naturel
- Pas de lipsync (screen recording), juste garder le rythme avec les slides

## Tests de clonage — Résultats

| Engine | Params | Verdict |
|--------|--------|---------|
| Chatterbox v1 | defaults, sample meeting 20s | Fonctionnel mais accent anglicisé |
| Qwen CustomVoice | defaults | Trop plat, robotique |
| Chatterbox v2 | defaults, sample 32s propre | Mieux mais toujours anglicisé |
| Chatterbox FR | cfg_weight=0.7, exaggeration=0.7, ref-text | Plus d'adhérence, à réévaluer |

**Décision** : Continuer les tests avec sample plus propre. Tester Qwen + Chatterbox avec différents params.

## Galerie audio

Déployée sur diagrams.roxabi.com → catégorie "Meeting Regen"

## A faire

- [ ] Tester avec sample encore plus propre (environnement silencieux)
- [ ] Ajuster cfg_weight / exaggeration pour sonner plus français
- [ ] Script diarization (pyannote-audio ~30 lignes)
- [ ] Script assemblage (split par speaker, merge chronologique, time-stretch)
- [ ] Traitement complet des 87 minutes
- [ ] Remux final vidéo + audio régénéré
