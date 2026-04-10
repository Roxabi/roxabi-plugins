# Forge Operations

Shared operational details for all forge skills. Read this once per invocation.

---

## Design Thinking — Think → Structure → Style → Deliver

All forge skills follow a creative process before generation:

1. **Think** — Pick aesthetic based on content type (base matrix below)
2. **Structure** — Choose rendering approach (skill-specific — see each SKILL.md)
3. **Style** — Select components (skill-specific — see each SKILL.md)
4. **Deliver** — Generate + verify against the skill's Deliver checklist

### Base aesthetic matrix (shared across all skills)

| Content type | Aesthetic | Reason |
|---|---|---|
| Personal AI / agent | `lyra.css` | Warm amber, human tone |
| Brand / company | `roxabi.css` | Gold, professional |
| Technical architecture / specs | `blueprint.css` | Clean lines, monospace |
| CLI / terminal | `terminal.css` | Monospace-heavy, dark |
| Blog / editorial / narrative | `editorial.css` | Serif titles, magazine feel |

**Ask:** What is the viewer's mental state? Technical exploration → Blueprint. Brand impression → Roxabi. Quick reference → Terminal. Narrative → Editorial.

Each skill may add skill-specific delta rows (e.g. `forge-gallery` adds *Design iterations → editorial* for visual exploration). Deltas live in each SKILL.md under its Design Phase section.

---

## Aesthetic Detection — Precedence Algorithm

The base matrix above is **judgment** (content-driven). The algorithm below is **precedence**: it runs top-to-bottom and the first match wins. Explicit args and brand book always override the Think matrix.

| Priority | Signal | Aesthetic |
|---|---|---|
| 1 | Explicit `--aesthetic` arg | As specified |
| 2 | Brand book found (`BRAND-BOOK.md`) | Derived from palette |
| 3 | Project = `lyra` / `voicecli` | `lyra.css` |
| 4 | Project = `roxabi*` / `2ndBrain` | `roxabi.css` |
| 5 | **Think matrix output** (content type) | Per matrix above |
| 6 | Default | `editorial.css` |

Sequence: Think produces a candidate → Detection validates against higher-priority signals → higher signals override. When nothing above priority 5 matches, the Think matrix is the answer.

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
