# Forge Operations

Shared operational details for all forge skills. Read this once per invocation.

---

## Design Flow — Frame → Structure → Style → Deliver

All forge skills follow this judgment flow during phases 1–4 (it is an overlay on top of the mechanical phases, not a separate pre-phase):

1. **Frame** (Phase 1) — Define **purpose**: who reads this, what do they do next, what tone does the content deserve. Full reference: [`frame-phase.md`](frame-phase.md) — three Frame questions, reader-action matrix, tone dimensions.
2. **Structure** (Phase 2) — Choose topology / template / tab set (skill-specific — see each SKILL.md).
3. **Style** (Phase 3) — Select component variants (skill-specific — see each SKILL.md).
4. **Deliver** (Phase 4) — Verify against the skill's Deliver checklist and the brand book's `deliver_must_match` rules (if `forge.yml` is present).

**Frame does not select aesthetics.** Aesthetic selection is mechanical — handled entirely by the precedence algorithm below. Frame produces a *purpose statement* that informs Structure (topology bias), Style (component variant), and Deliver (verification criterion).

### Content-type fallback matrix

Used only when the Aesthetic Detection chain reaches priority 5 (no explicit arg, no brand book, no project-name match). Derived from Frame Q1 (reader) + Q3 (tone). Full reader-action matrix lives in `frame-phase.md`.

| Content signal | Fallback aesthetic | Reason |
|---|---|---|
| Personal AI / agent / warm narrative | `lyra.css` | Warm amber, human tone |
| Brand / company / pitch | `roxabi.css` | Gold, professional |
| Technical architecture / debug / audit | `blueprint.css` | Clean lines, monospace |
| CLI / terminal reference | `terminal.css` | Monospace-heavy, dark |
| Editorial / long-form / browsing | `editorial.css` | Serif titles, magazine feel |

This table is a **mechanical fallback** for the precedence chain, not a judgment prompt. The judgment lives in `frame-phase.md`.

---

## Aesthetic Detection — Precedence Algorithm

Runs top-to-bottom; first match wins. Explicit args and brand book always override Frame-driven fallback.

| Priority | Signal | Aesthetic |
|---|---|---|
| 1 | Explicit `--aesthetic` arg | As specified |
| 2 | **`forge.yml` present** (structured brand book — see `brand-book-schema.md`) | Per brand book `aesthetic:` field; full component/palette lock applies |
| 3 | Legacy `BRAND-BOOK.md` found (palette only) | Derived from palette table |
| 4 | Project = `lyra` / `voicecli` / `roxabi*` / `2ndBrain` | `lyra.css` or `roxabi.css` per project |
| 5 | **Frame content-type fallback** (from matrix above, using Frame Q1+Q3 output) | Per matrix |
| 6 | Default | `editorial.css` |

**Two-track mode based on priority 2:**

- **Track A — branded mode** (`forge.yml` present): priority 2 fires. Frame runs in reduced form — tone is pre-constrained by brand book's `deliver_must_match` rules. Structure/Style pre-fill from brand book's `components:` field. Aesthetic is locked.
- **Track B — exploration mode** (no `forge.yml`): priority 2 skips. Frame runs in full — all four Frame questions asked. Aesthetic falls through to priority 3/4/5 as normal.

When priority 5 fires (exploration mode, unknown project), the fallback matrix maps Frame's purpose statement to one of the 5 aesthetic CSS files. When nothing matches, priority 6 (`editorial.css`) is the last resort.

---

## Brand Book Detection

Check these paths in order (first found wins):

```bash
# 1. Preferred — structured config (full schema, locks decisions)
ls ~/projects/{PROJ}/brand/forge.yml 2>/dev/null
ls ~/.roxabi/forge/{PROJ}/brand/forge.yml 2>/dev/null

# 2. Legacy — palette-only Markdown brand book
ls ~/.roxabi/forge/{PROJ}/brand/BRAND-BOOK.md 2>/dev/null
ls ~/projects/{PROJ}/brand/BRAND-BOOK.md 2>/dev/null
```

**`forge.yml` found** → load as full decision substrate. Aesthetic, palette, typography, components, examples, and deliver constraints all apply per the schema in `brand-book-schema.md`. Skills skip Frame phase and enter **branded mode**.

**Legacy `BRAND-BOOK.md` found** → derive CSS tokens from its palette table only (override defaults in `tokens.md`). Components, structure, and deliver constraints fall through to plugin defaults.

**Nothing found** → use project-name fallback:

| Project | Theme |
|---------|-------|
| `lyra`, `voicecli` | Lyra / Forge Orange |
| `roxabi*`, `2ndBrain` | Roxabi / Gold |
| Unknown | Lyra (default) |

Schema reference: `references/brand-book-schema.md`. Concrete example: `references/examples/forge.yml.example`.

---

## Output Paths

| Context | Skills | Path |
|---------|--------|------|
| Exploration / iteration (default) | guide, epic, chart | `~/.roxabi/forge/<project>/visuals/` |
| Final / canonical (ARGS contains "final" or "docs") | guide only | `~/projects/<project>/docs/visuals/` |
| Gallery HTML | gallery | `~/.roxabi/forge/<project>/` |
| Gallery shared assets | gallery | `~/.roxabi/forge/_shared/gallery-base.css` + `.js` |
| Cross-project chart | chart | `~/.roxabi/forge/_shared/diagrams/` |

**Gallery shared assets:** `gallery-base.css` and `gallery-base.js` must exist at `~/.roxabi/forge/_shared/`. Gallery HTMLs link to them via relative path (e.g. `../../_shared/gallery-base.css`). Copy from `references/gallery-templates/` on first deploy.

---

## Serving

### Quick (no setup)

```bash
# Split-file guide or epic — serve from the visuals dir
cd ~/.roxabi/forge/<project>/visuals && python3 -m http.server 8080
# → http://localhost:8080/<name>.html

# Chart — no server needed (single-file, all inline)
# open file://~/.roxabi/forge/<project>/visuals/<name>.html

# Gallery — serve from the forge root (galleries use relative paths to _shared/)
cd ~/.roxabi/forge && python3 -m http.server 8080
# → http://localhost:8080/<project>/<gallery>.html
```

### Persistent daemon (optional)

For always-on serving with live reload and manifest auto-regen, see `references/forge-makefile.md` for Makefile targets and supervisor config to add to the project.

If `make forge` targets exist, use them:

```bash
make forge start     # start dev server on :8080
make forge status    # check if running
make forge logs      # tail stdout
make forge deploy    # build + deploy
```

If not set up, `python3 -m http.server` works fine — just regenerate `manifest.json` manually after adding new diagrams.

---

## Deploy

If the project has a `make forge deploy` target, use it. Otherwise, deploy is optional — galleries work locally via `python3 -m http.server`.

See `references/forge-makefile.md` for the full Makefile snippet (minimal or full with supervisor + Cloudflare).

---

## Project Detection

Detect project from ARGS or cwd. Check in order:

1. Explicit project name in ARGS
2. `CLAUDE.md` in cwd (project name often in heading)
3. `pyproject.toml` → `[project] name`
4. `package.json` → `name`
5. `git remote -v` → extract repo name from origin URL

Unknown → DP(B): ask.
