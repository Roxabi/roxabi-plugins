---
name: forge-init
description: 'Initialize the forge environment — create ~/.roxabi/forge/, copy serve.py + index.html + shared assets, verify structure. Triggers: "init forge" | "setup forge" | "forge init" | "forge setup" | "initialize forge".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob, Grep, ToolSearch
---

# Forge Init

Set up `~/.roxabi/forge/` with the dev server, shared gallery assets, and directory structure.

Run once per machine. Safe to re-run — skips files that already exist.

---

## Phase 1 — Check Current State

```bash
ls -la ~/.roxabi/forge/ 2>/dev/null
ls ~/.roxabi/forge/_shared/gallery-base.css 2>/dev/null
ls ~/.roxabi/forge/_shared/gallery-base.js 2>/dev/null
ls ~/.roxabi/forge/serve.py 2>/dev/null
ls ~/.roxabi/forge/index.html 2>/dev/null
```

Report what exists and what's missing.

---

## Phase 2 — Create Structure

Create directories if missing:

```bash
mkdir -p ~/.roxabi/forge/_shared
mkdir -p ~/.roxabi/forge/_dist
```

---

## Phase 3 — Copy Files

Copy from plugin references. Source files:

```
${CLAUDE_PLUGIN_ROOT}/references/server/serve.py      → ~/.roxabi/forge/serve.py
${CLAUDE_PLUGIN_ROOT}/references/server/index.html     → ~/.roxabi/forge/index.html
${CLAUDE_PLUGIN_ROOT}/references/gallery-templates/gallery-base.css → ~/.roxabi/forge/_shared/gallery-base.css
${CLAUDE_PLUGIN_ROOT}/references/gallery-templates/gallery-base.js  → ~/.roxabi/forge/_shared/gallery-base.js
```

For each file:
- If target exists → compare with source. If identical → skip ("already up to date"). If different → ask user: **Update** | **Keep existing** | **Diff**
- If target missing → copy and report

Make `serve.py` executable:

```bash
chmod +x ~/.roxabi/forge/serve.py
```

---

## Phase 4 — Verify

```bash
ls -la ~/.roxabi/forge/serve.py ~/.roxabi/forge/index.html
ls -la ~/.roxabi/forge/_shared/gallery-base.*
```

---

## Phase 5 — Report

```
── Forge Initialized ──

Root:    ~/.roxabi/forge/
Server:  ~/.roxabi/forge/serve.py
Index:   ~/.roxabi/forge/index.html
Shared:  ~/.roxabi/forge/_shared/gallery-base.{css,js}

Quick start:
  cd ~/.roxabi/forge && python3 serve.py
  → http://localhost:8080/

Or set FORGE_DIR and FORGE_PORT:
  FORGE_DIR=~/.roxabi/forge FORGE_PORT=9090 python3 ~/.roxabi/forge/serve.py

See references/forge-makefile.md for Makefile + supervisor integration.
```

$ARGUMENTS
