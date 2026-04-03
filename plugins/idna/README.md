# forge-ideas

Evolutionary idea selector for creative assets. Explore diverse variants, pick a winner, converge through mutations, finalize.

## What it does

Bootstraps a self-driving selection session: the browser lets you pick, a local server calls Claude to generate mutation prompts, imageCLI/voiceCLI renders the next round, and the browser auto-advances — no back-and-forth needed.

**Supports:** avatar images, voice styles, writing tones, logo concepts, or any asset that can be generated in variants.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install forge-ideas
```

## Use

Trigger phrases:
- `forge ideas` / `evolutionary selector` / `explore and converge`
- `selection forge for <subject>` / `refine to a winner`

Example:
> "forge ideas for Lyra's avatar — young woman, warm approachable feel"

The skill will:
1. Create a session at `~/.roxabi/forge/<project>/<subject>/`
2. Generate round 0 (4 diverse variants)
3. Start the forge server on port 8082
4. Tell you to open `http://localhost:8080/...`

From there, pick in the browser — everything else is automatic.

## How it works

```
Browser → POST /api/pick → forge_server.py
  → Claude API: generates 3 mutation prompts (amplify / blend / refine)
  → generate_round.py: 2-phase FLUX.2-klein (encode all → generate all)
  → session.json: status=ready
Browser polls → auto-renders new round
```

## Session anatomy

```
~/.roxabi/forge/<project>/<subject>/
  session.json          ← state machine
  forge.html            ← browser picker
  forge_server.py       ← autonomous backend (port 8082)
  generate_round.py     ← image gen (imageCLI)
  round_0/
    v0.png … v3.png     ← explore variants
    prompts/            ← job JSON files
    embeds/             ← cached text embeddings
  round_1/
    va.png vb.png vc.png ← amplify / blend / refine
    ...
```

## Keyboard shortcuts (in browser)

| Phase | Keys |
|-------|------|
| Explore | `1` `2` `3` `4` to select · `Enter` to confirm |
| Converge | `a` `b` `c` to select · `Enter` to confirm · `f` to finalize |
| Both | `t` to toggle dark/light mode |
