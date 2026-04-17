# IDNA Operations

Shared operational details for all idna skills. Read this once per invocation.

---

## Directory Layout

```
~/.roxabi/idna/                        ← IDNA root (default, override with IDNA_DIR env var)
  idna/                                ← Python package (deployed from roxabi-plugins)
    __init__.py
    config.py
    server.py
    api.py  api_new.py
    session.py  nodes.py  generation.py
    daemon.py  hires.py
    html_index.py  html_picker.py  …
  idna_server.py                       ← thin entry point (from idna.server import main)
  templates/                           ← Claude prompt templates
  <project>/<subject>/
    session.json                       ← state machine
    round_0/
      v0.png … v3.png                  ← explore variants
      prompts/v0.json … v3.json        ← job files
      embeds/v0.pt … v3.pt             ← cached text embeddings
    round_N/
      <id>va.png  <id>vb.png  …        ← amplify / blend / refine
      prompts/  embeds/
```

**Never inside `~/.roxabi/forge/`** — forge is Cloudflare-deployed. IDNA is local-only.

### IDNA_DIR

Override the root with the `IDNA_DIR` environment variable:

```bash
IDNA_DIR=/custom/path uv run idna_server.py
```

Default fallback: `~/.roxabi/idna/`

---

## Supervisord

Single program name: `idna`

```bash
make idna              # status
make idna start        # start
make idna stop         # stop
make idna reload       # restart
make idna logs         # stdout
make idna errlogs      # stderr
```

Conf: `~/projects/lyra/deploy/supervisor/conf.d/idna.conf`  
`autostart=false` — start manually when needed.

---

## Server

Port: **8082** (fixed, or pass as first arg: `uv run idna_server.py 8083`)  
URL: `http://localhost:8082/`

Single shared server process — hosts all sessions:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Landing page — lists all sessions |
| GET | `/<project>/<subject>/` | Browser picker |
| GET | `/<project>/<subject>/api/status` | Session state |
| GET | `/<project>/<subject>/api/tree` | Full node tree |
| POST | `/api/new` | SSE — create session pipeline |
| POST | `/<project>/<subject>/api/pick` | `{"node_id": "v0va"}` |
| POST | `/<project>/<subject>/api/back` | Undo last pick |
| POST | `/<project>/<subject>/api/reroll` | Reroll current round |
| POST | `/<project>/<subject>/api/finalize` | Lock winner, trigger hi-res |
| POST | `/<project>/<subject>/api/nudge` | `{"text": "more contrast"}` |

Uses **imageCLI daemon** (unix socket) for image generation — daemon must be running for image sessions.

---

## Session State Machine

```
phase: picking
  gen_status: idle → generating → idle   (each round)
  path: [] → [v0] → [v0, v0va] → …

phase: finalizing  (after /api/finalize)
  winner: <node_id>
  hi-res regen running in background

phase: done
```

---

## Artifact Type Support

| Type | Generator | Notes |
|------|-----------|-------|
| Image | imageCLI daemon (FLUX.2-klein) | 2-phase: encode all → generate all |
| Other | — | future: voice (voiceCLI), text (inline) |

Template determines artifact type (`avatar`, `logo` → image; others → tbd).

---

## Project Detection

Detect project + subject from ARGS or cwd:
1. Explicit in ARGS: `"idna for lyra avatar"` → project=lyra, subject=avatar
2. CLAUDE.md heading in cwd
3. `pyproject.toml` → `[project] name`
4. Ask if ambiguous

Session dir: `~/.roxabi/idna/<project>/<subject>/`

---

## Node ID Convention

| Round | IDs |
|-------|-----|
| Round 0 (explore) | `v0`, `v1`, `v2`, … (width nodes) |
| Round N (converge) | `<parent_id>va`, `<parent_id>vb`, … |

Reroll appends `:r1`, `:r2` to the seed suffix — produces different mutations without changing node IDs.
