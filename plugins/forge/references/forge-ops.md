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

```bash
# Full gallery — diagrams supervisord on :8080
http://localhost:8080/

# Standalone (split-file guide or epic)
cd ~/.roxabi/forge/<project>/visuals && python3 -m http.server 8080

# Chart — no server needed
file://~/.roxabi/forge/<project>/visuals/<name>.html
```

---

## Deploy

```bash
cd ~/projects/lyra-stack && make diagrams deploy
```

---

## Project Detection

Detect project from ARGS or cwd. Check in order:

1. Explicit project name in ARGS
2. `CLAUDE.md` in cwd (project name often in heading)
3. `pyproject.toml` → `[project] name`
4. `package.json` → `name`
5. `git remote -v` → extract repo name from origin URL

Unknown → DP(B): ask.
