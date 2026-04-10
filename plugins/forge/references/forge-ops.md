# Forge Operations

Shared operational details for all forge skills. Read this once per invocation.

---

## Design Thinking — Think → Structure → Style → Deliver

All forge skills follow a creative process before generation:

1. **Think** — Pick aesthetic based on content type (Blueprint for tech, Editorial for narrative, Lyra for personal AI)
2. **Structure** — Choose rendering approach (Mermaid for flows, fgraph for radial, Grid for text-heavy)
3. **Style** — Select components (hero variant, section labels, card types)
4. **Deliver** — Generate + verify against wow examples

Each skill has its own Design Phase section with specific decision tables. Read the skill's SKILL.md for content-specific guidance.

---

## Brand Book Detection

Check these paths in order (first found wins):

```bash
ls ~/.roxabi/forge/{PROJ}/brand/BRAND-BOOK.md 2>/dev/null
ls ~/projects/{PROJ}/brand/BRAND-BOOK.md 2>/dev/null
```

Found → derive CSS tokens from its palette (override defaults in `tokens.md`).
Not found → use fallback:

| Project | Theme |
|---------|-------|
| `lyra`, `voicecli` | Lyra / Forge Orange |
| `roxabi*`, `2ndBrain` | Roxabi / Gold |
| Unknown | Lyra (default) |

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
