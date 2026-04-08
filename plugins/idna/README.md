# idna

Evolutionary asset selector. Explore diverse variants, pick a direction, converge through mutations, finalize a winner.

## What it does

Creates a self-driving selection session: a shared local server calls Claude to generate mutation prompts, imageCLI renders the next round, and the browser auto-advances — no back-and-forth needed.

**Supports:** avatar images, logo concepts, voice styles, writing tones, or any asset that can be generated in variants.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install idna
```

## Use

Trigger phrases:
- `idna for <subject>` / `evolutionary selector` / `explore and converge`
- `selection session for <subject>` / `refine to a winner`

Example:
> "idna for Lyra's avatar — young woman, warm approachable feel"

The skill will:
1. Create a session at `~/.roxabi/idna/<project>/<subject>/`
2. Generate round 0 (4 diverse variants)
3. Open `http://localhost:8082/<project>/<subject>/` in the browser

From there, pick in the browser — everything else is automatic.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `IDNA_DIR` | `~/.roxabi/idna/` | Root directory for sessions and server package |

## How it works

```
Browser → POST /api/pick → idna server (port 8082)
  → Claude API: generates mutation prompts (amplify / blend / refine)
  → imageCLI daemon: 2-phase encode all → generate all
  → session.json: gen_status=idle
Browser polls /api/status → auto-renders new round
```

## Session anatomy

```
~/.roxabi/idna/<project>/<subject>/
  session.json          ← state machine (phase, path, nodes, winner)
  round_0/
    v0.png … v3.png     ← explore variants
    prompts/            ← job JSON files
    embeds/             ← cached text embeddings
  round_1/
    v0va.png  v0vb.png  v0vc.png   ← amplify / blend / refine
    ...
```

## Keyboard shortcuts (in browser)

| Keys | Action |
|------|--------|
| `1` `2` `3` `4` | Select card |
| `Enter` | Confirm pick |
| `←` (parent card) | Reroll — fresh variants from same parent |
| `b` | Back — undo last pick |
| `f` | Finalize — lock winner, trigger hi-res |
| `t` | Toggle dark/light mode |

## Server management

```bash
make idna start    # start server
make idna reload   # restart
make idna stop     # stop
make idna logs     # stdout
make idna errlogs  # stderr
```
