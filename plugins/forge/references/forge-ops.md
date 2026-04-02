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

| Context | Path |
|---------|------|
| Exploration / iteration (default) | `~/.roxabi/forge/<project>/visuals/` |
| Final / canonical (ARGS contains "final" or "docs") | `~/projects/<project>/docs/visuals/` |
| Gallery | `~/.roxabi/forge/<project>/` |
| Cross-project chart | `~/.roxabi/forge/_shared/diagrams/` |

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

Detect project from ARGS or cwd. Signals: `CLAUDE.md`, `pyproject.toml`, `package.json`, git remote name. Unknown → DP(B): ask.
