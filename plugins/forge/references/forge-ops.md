# Forge Operations

Shared operational details for all forge skills. Read this once per invocation.

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

If the project has a supervisor setup with a `make forge` target, use that instead:

```bash
make forge start     # start dev server on :8080
make forge status    # check if running
make forge logs      # tail stdout
make forge reload    # restart after config changes
```

A dedicated dev server can provide: auto-regeneration of `manifest.json` on HTML changes, SSE live reload, `/api/list/` endpoint for image/audio discovery, and a gallery index UI.

If no daemon is available, `python3 -m http.server` works fine — just regenerate `manifest.json` manually after adding new diagrams.

---

## Deploy

If the project has a `make forge deploy` target, use it. Otherwise, deploy is optional — galleries work locally via `python3 -m http.server`.

---

## Project Detection

Detect project from ARGS or cwd. Check in order:

1. Explicit project name in ARGS
2. `CLAUDE.md` in cwd (project name often in heading)
3. `pyproject.toml` → `[project] name`
4. `package.json` → `name`
5. `git remote -v` → extract repo name from origin URL

Unknown → DP(B): ask.
