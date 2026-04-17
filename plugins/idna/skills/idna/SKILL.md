---
name: idna
description: 'Bootstrap and run an evolutionary idea selector — explore diverse variants, pick a winner, converge through amplify/blend/refine mutations until a final candidate emerges. Self-driving: browser picks → Claude generates prompts → imageCLI/voiceCLI renders → browser auto-advances. Triggers: "forge ideas" | "evolutionary selector" | "explore and converge" | "selection forge" | "pick from variants" | "refine to a winner".'
version: 0.1.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch
---

# Forge Ideas — Evolutionary Selector

Bootstrap a self-driving selection session for any creative asset: avatar images, voice styles, writing tones, logo concepts, etc.

**Flow:** Explore (N diverse variants) → pick winner → Converge (amplify / blend / refine) → repeat until Finalize.

**Stack:**
- `session.json` — state machine (current round, winner, variants, phase, status)
- `forge.html` — dynamic browser picker (polls the server, auto-advances rounds)
- `forge_server.py` — local HTTP server (port 8082) that calls Claude API for next-round prompts and triggers generation
- `generate_round.py` — 2-phase image generation script (imageCLI / FLUX.2-klein)

**Read before implementing:**
```
${CLAUDE_PLUGIN_ROOT}/references/idna-session-schema.md     — session.json structure + state machine
${CLAUDE_PLUGIN_ROOT}/references/idna_server.py             — forge_server.py reference implementation
${CLAUDE_PLUGIN_ROOT}/references/idna-template.html   — forge.html reference implementation
${CLAUDE_PLUGIN_ROOT}/references/idna-generate-round.py     — 2-phase image gen reference (imageCLI)
```

---

## Phase 1 — Understand the request

Identify:
1. **Subject** — what is being selected? (avatar image, voice style, writing style, logo, ...)
2. **Artifact type** — image (imageCLI/FLUX.2-klein) | voice (voiceCLI) | text | other
3. **Identity** — fixed description that stays constant across all variants (physical identity for avatar, voice characteristics for voice style, etc.)
4. **Output dir** — where to put the session (`~/.roxabi/forge/<project>/<subject>/`)

Ask the user for any missing info before proceeding.

---

## Phase 2 — Bootstrap the session

Create the output directory and the three runtime files.

### 2a. session.json

Create `<output_dir>/session.json` from the schema in `references/idna-session-schema.md`.

Initial state:
- `phase: "explore"`, `round: 0`, `status: "ready"`
- `winner: null`, `runner_up: null`, `cycle_winners: []`
- `identity`: the fixed description provided by the user
- `rounds[0]`: 4 variants for the explore phase — generate diverse params covering different poles:
  - Variant 0: neutral / professional
  - Variant 1: warm / inviting
  - Variant 2: focused / technical
  - Variant 3: atmospheric / expressive

For each variant, set `params` (expression, lighting, framing, mood for images; tone, pace, affect for voice; etc.) and compose the full `prompt` string by combining identity + params.

Set seeds: round 0 → seeds 0–3, round N → seeds N×100 to N×100+2.

### 2b. forge_server.py

Copy `references/idna_server.py` and adapt:
- Set `FORGE_DIR` to the output directory
- Set `IMAGECLI_PROJECT` to the appropriate generator project path (imageCLI for images, voiceCLI for voice)
- Set `GENERATE_SCRIPT` to the appropriate round generator script
- Update `MUTATION_SYSTEM` / `MUTATION_USER_TMPL` to match the artifact type (portrait prompts for images, voice style descriptions for voice, etc.)
- For non-image types: replace the generation subprocess with the correct CLI call

### 2c. forge.html

Copy `references/idna-template.html` as-is — it reads all state from the server dynamically, no modifications needed unless the artifact type requires a different display (e.g. audio player instead of image grid).

### 2d. generate_round.py (images only)

Copy `references/idna-generate-round.py` to the output directory. No modifications needed — it reads job files from `round_N/prompts/` and writes PNGs to `round_N/`.

---

## Phase 3 — Generate round 0 variants

### For image type:

Create `<output_dir>/round_0/prompts/` and write one JSON job file per variant:
```json
{"id": "v0", "label": "V0", "seed": 0, "width": 768, "height": 1024, "prompt": "..."}
```

Then run generation:
```bash
cd <output_dir>
uv run --project ~/projects/imageCLI python generate_round.py round_0 --steps 28
```

### For voice type:

Create audio samples using voiceCLI with the variant params.

### For text/other type:

Render the variants as text files or show them inline in forge.html.

---

## Phase 4 — Start the forge server

Add to supervisord (`~/projects/lyra-stack/conf.d/`) with `autostart=false`:

```ini
[program:forge-<subject>]
command=uv run <output_dir>/forge_server.py
directory=<output_dir>
environment=HOME="%(ENV_HOME)s",PATH="%(ENV_HOME)s/.local/bin:%(ENV_PATH)s"
autostart=false
autorestart=true
...
```

Then start:
```bash
supervisorctl reread && supervisorctl update
supervisorctl start forge-<subject>
```

---

## Phase 5 — Tell the user

Report:
- Session created at `<output_dir>/`
- Forge server running on `http://localhost:8082`
- Images (if generated) ready for viewing
- Browser: `http://localhost:8080/<project>/<subject>/forge.html`
- Keyboard shortcuts: `1/2/3/4` to select, `Enter` to confirm (explore) · `a/b/c` (converge) · `f` to finalize

---

## Convergence logic (for reference — the server handles this automatically)

After a pick:
- **amplify** — push the winner's dominant quality to its extreme
- **blend** — cross the winner with a contrasting pole (warmth + intellect, energy + calm, etc.)
- **refine** — polish the winner: cleaner execution, tighter composition, same essence

Plateau detection: if the user picks the same mutation type twice in a row (e.g. refine twice), suggest finalizing.

---

$ARGUMENTS
