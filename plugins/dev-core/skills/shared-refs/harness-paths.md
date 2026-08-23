# Harness paths

SSoT for resolving bundled skill files. One skill body — never fork per host.

`SKILL_DIR` := folder that contains the invoking `SKILL.md`.

| Host | This skill's files | Cross-skill file |
|---|---|---|
| Claude / Grok | `$CLAUDE_SKILL_DIR/<file>` (Grok aliases this) | `skill://<other>/<file>` if the host resolves it; else `$CLAUDE_PLUGIN_ROOT/skills/<other>/<file>` |
| OMP | `skill://<this>/<file>` (`..` rejected; `/skill:` also injects baseDir) | `skill://<other>/<file>` |
| Cursor | relative path from the skill root ([docs](https://cursor.com/docs/skills)) | relative only if the file lives in **this** skill; otherwise `skill://<other>/<file>` |

Rules:

1. Scripts are self-locating (`dirname "$0"`). Do not `cd` to the product repo to find them.
2. Never `../` in a skill body (OMP rejects it; it is also the product-repo cwd trap).
3. Never invent a host env var. Cursor has no `CURSOR_SKILL_DIR`. Cursor plugin `variables` are user-declared `${VAR}` in `mcp.json`, not a skill-dir inject.
4. Product-repo cwd is never `SKILL_DIR`.

Read this file: `skill://shared-refs/harness-paths.md`.
