---
name: idna-init
description: 'Bootstrap a new IDNA evolutionary selector session — create session dir, copy server + picker + generator, write round 0 variants, start server. Triggers: "init idna" | "new idna session" | "idna init" | "start idna for" | "bootstrap idna".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob, Grep, ToolSearch
---

# IDNA Init

Bootstrap a new evolutionary selector session for any creative asset.

**Read before starting:**
```
${CLAUDE_PLUGIN_ROOT}/references/idna-ops.md       — dir layout, ports, supervisord, state machine
${CLAUDE_PLUGIN_ROOT}/references/idna-session-schema.md  — session.json format
```

---

## Phase 1 — Understand the request

From ARGS or conversation, identify:

| Field | Description | Example |
|-------|-------------|---------|
| `project` | Project name | `lyra` |
| `subject` | What's being selected | `avatar`, `voice-style`, `logo` |
| `type` | Artifact type | `image` \| `voice` \| `text` |
| `identity` | Fixed description (never mutated) | Physical description, voice characteristics |

Missing info → ask in one sentence before proceeding.

Session dir: `~/.roxabi/idna/<project>/<subject>/`

---

## Phase 2 — Check existing session

```bash
ls ~/.roxabi/idna/<project>/<subject>/session.json 2>/dev/null
```

If exists → DP(A):
```
── Decision: Session already exists ──
Context: ~/.roxabi/idna/<project>/<subject>/session.json found (status: <status>, round: <N>)
Options:
  1. Resume — open existing session in browser
  2. Reset  — overwrite with a fresh session
Recommended: Option 1 — avoid losing existing work
```

---

## Phase 3 — Create directory structure

```bash
mkdir -p ~/.roxabi/idna/<project>/<subject>/round_0/prompts
mkdir -p ~/.roxabi/idna/<project>/<subject>/round_0/embeds
```

---

## Phase 4 — Copy runtime files

Copy from plugin references (skip if already exists and identical):

```
${CLAUDE_PLUGIN_ROOT}/references/idna_server.py         → ~/.roxabi/idna/<project>/<subject>/idna_server.py
${CLAUDE_PLUGIN_ROOT}/references/idna-template.html     → ~/.roxabi/idna/<project>/<subject>/idna-template.html
${CLAUDE_PLUGIN_ROOT}/references/idna-generate-round.py → ~/.roxabi/idna/<project>/<subject>/idna_generate_round.py
```

For image type only — copy the generator script.
For other types — skip `idna_generate_round.py` and adapt `idna_server.py` generation subprocess.

---

## Phase 5 — Write seed session.json

Create `~/.roxabi/idna/<project>/<subject>/session.json` (minimal — `idna_build_tree.py` fills the rest):

```json
{
  "id": "<project>-<subject>-001",
  "type": "<type>",
  "subject": "<human description>",
  "identity": "<fixed identity — physical description, never mutated>"
}
```

`identity` is the only field Claude needs to generate prompts. The tree builder adds `nodes`, `queue`, `depth`, `phase`, `gen_status`.

---

## Phase 6 — Build the full prompt tree

```bash
cd ~/.roxabi/idna
uv run --project ~/projects/imageCLI python idna_build_tree.py <project>/<subject> --depth 3
```

This generates ALL node prompts upfront in 2 Claude calls (depth=3 → 160 nodes):
- Call 1: rounds 0–1 (4 + 12 = 16 nodes)
- Call 2: rounds 2–3 (36 + 108 = 144 nodes)

Node IDs are deterministic: `v0`, `v0-va`, `v0-va-vb`, …  
Seeds: round×100 + mutation_index  
Tree nodes: 384×512 (fast selection); final winner re-gen: 768×1024

Output: job files in `round_N/prompts/<id>.json`, updated `session.json`.

---

## Phase 7 — Encode all prompts (image type)

```bash
cd ~/.roxabi/idna
uv run --project ~/projects/imageCLI python idna_encode_all.py <project>/<subject>
```

Loads Qwen3 text encoder ONCE, encodes all 160 nodes → `round_N/embeds/<id>.pt`.
Takes ~30–60s. Much faster than encoding per-round during generation.

---

## Phase 8 — Start the central IDNA server

The central server at `~/.roxabi/idna/idna_server.py` handles all sessions.
It is registered as program `idna` in `~/projects/lyra-stack/conf.d/idna.conf`.

```bash
cd ~/projects/lyra-stack
make idna start    # or: supervisorctl start idna
```

On start, the server auto-detects all `session.json` files and begins BFS image generation
(round 0 first, then pre-warms deeper rounds while you pick).

Open the picker: `http://localhost:8082/<project>/<subject>/`

---

## Phase 9 — Report

```
── IDNA Session Ready ──

Session:  ~/.roxabi/idna/<project>/<subject>/
Picker:   http://localhost:8082/<project>/<subject>/
Index:    http://localhost:8082/

Tree: depth=3 → 160 nodes pre-prompted (2 Claude calls)
      384×512 for selection · 768×1024 for final winner

Generation: auto-BFS in background (round 0 first, ~60–90s)

Controls:
  make idna start|stop|logs        (from ~/projects/lyra-stack)
  Click/keyboard to pick variants in browser
```

$ARGUMENTS
