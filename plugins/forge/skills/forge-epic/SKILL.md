---
name: forge-epic
description: 'Create an issue/epic-linked visual analysis — overview, scope breakdown, dependency graph, acceptance criteria. Filename always includes the issue number. Triggers: "visualize #N" | "preview #N" | "illustrate issue" | "map issue" | "epic preview" | "show epic".'
version: 0.1.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch
---

# Epic — Issue-Linked Visual Analysis

Create a visual analysis document tied to a specific GitHub issue or epic (`#N`).
Style reference: `tool-registry-477.html`.

Output: `~/.roxabi/forge/<project>/visuals/{N}-{slug}.html` (split-file).

**Read before generating:**

```
${CLAUDE_PLUGIN_ROOT}/references/split-file.md    — templates + CSS/JS skeletons
${CLAUDE_PLUGIN_ROOT}/references/tokens.md        — CSS tokens + dark mode rules
${CLAUDE_PLUGIN_ROOT}/references/diagram-meta.md  — meta tag format + categories
${CLAUDE_PLUGIN_ROOT}/references/mermaid-guide.md — dependency/breakdown diagrams
```

Let:
  ARGS   := $ARGUMENTS
  ISSUE  := GitHub issue number (required — extract from ARGS or ask)
  AG     := `~/.roxabi/forge/`

---

## Phase 1 — Context

1. **Extract issue number** from ARGS (e.g. `#477`, `477`, "issue 477"). Not found → DP(B): "Which issue number is this epic for?"

2. **Detect project** from ARGS or cwd.

3. **Brand book** (first found):
   ```bash
   ls ~/.roxabi/forge/{PROJ}/brand/BRAND-BOOK.md 2>/dev/null
   ls ~/projects/{PROJ}/brand/BRAND-BOOK.md 2>/dev/null
   ```

4. **Slug** from ARGS title or issue title (kebab-case). Filename: `{ISSUE}-{slug}.html`.
   Check: `ls ~/.roxabi/forge/{PROJ}/visuals/{ISSUE}-*.html 2>/dev/null`
   ∃ → offer to update or create a new version.

5. **Read issue context** if accessible:
   - Check `~/projects/{PROJ}/` for relevant CLAUDE.md, specs, or any `docs/` referencing `#{ISSUE}`
   - Check git log: `cd ~/projects/{PROJ} && git log --oneline --grep="#{ISSUE}" 2>/dev/null | head -10`

---

## Phase 2 — Epic Structure

Determine tabs based on issue scope. Standard epic layout:

| Tab ID | Label | Content |
|--------|-------|---------|
| `overview` | Overview | What + Why + Scope — hero section with issue title, problem statement, goal |
| `breakdown` | Breakdown | Sub-tasks / milestones as cards or table; status badges |
| `deps` | Dependencies | Mermaid dependency/flow diagram (issues blocked by / blocking) |
| `criteria` | Acceptance | Checklist-style acceptance criteria table |

Adjust tabs to what the issue actually contains — simpler epics may need only `overview` + `deps`.

**Choose meta values:**
- `diagram:category` → `spec` for a feature spec, `plan` for implementation plan, `analysis` for research
- `diagram:issue` → ISSUE number (no `#`)
- `diagram:color` → match project (amber=Lyra, gold=Roxabi, etc.)

---

## Phase 3 — Generate

**File paths:**
```
~/.roxabi/forge/{PROJ}/visuals/{ISSUE}-{slug}.html
~/.roxabi/forge/{PROJ}/visuals/css/{ISSUE}-{slug}.css
~/.roxabi/forge/{PROJ}/visuals/js/{ISSUE}-{slug}.js
~/.roxabi/forge/{PROJ}/visuals/tabs/{ISSUE}-{slug}/tab-{ID}.html
```

**Shell HTML** — include `diagram:issue` meta:
```html
<!-- diagram-meta:start -->
<meta name="diagram:title"     content="{PROJ} #{ISSUE} — {Title}">
<meta name="diagram:date"      content="{YYYY-MM-DD}">
<meta name="diagram:category"  content="{category}">
<meta name="diagram:cat-label" content="{Label}">
<meta name="diagram:color"     content="{color}">
<meta name="diagram:badges"    content="latest">
<meta name="diagram:issue"     content="{ISSUE}">
<!-- diagram-meta:end -->
```

**Page title convention:** `{PROJ} #{ISSUE} — {Short Title}` (e.g. "Lyra #477 — Tool Registry: Ecosystem Analysis").

**Overview tab** — hero section with context:
```html
<div class="epic-hero">
  <div class="epic-number">#{ISSUE}</div>
  <h1>{Title}</h1>
  <p class="epic-goal">{one-sentence goal}</p>
</div>
<div class="cards">
  <div class="card accent"><div class="card-label">Scope</div><div class="card-body">…</div></div>
  <div class="card accent"><div class="card-label">Status</div><div class="card-body">…</div></div>
  <div class="card accent"><div class="card-label">Blocked by</div><div class="card-body">…</div></div>
</div>
```

CSS for epic-hero (add to `{ISSUE}-{slug}.css`):
```css
.epic-hero { margin-bottom: 2rem; }
.epic-number { font-family: 'IBM Plex Mono', monospace; font-size: 0.875rem; color: var(--accent); font-weight: 600; margin-bottom: 0.5rem; }
.epic-goal { font-size: 1.125rem; color: var(--text-muted); margin-top: 0.5rem; }
```

**Breakdown tab** — use `.cards` grid or a `.table-wrap > table` with status column:
```html
<span class="status done">done</span>
<span class="status wip">in progress</span>
<span class="status todo">todo</span>
```
```css
.status { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 3px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
.status.done { background: #14532d; color: #86efac; }
.status.wip  { background: #78350f; color: #fcd34d; }
.status.todo { background: #1e3a5f; color: #93c5fd; }
```

**Deps tab** — Mermaid dependency diagram. Follow `references/mermaid-guide.md` checklist exactly (dynamic tab pitfalls).

**Acceptance criteria tab** — table: | Criterion | Type | Status |

Dark mode text rules always apply (see `references/tokens.md`).

---

## Phase 4 — Report

```
Created:
  ~/.roxabi/forge/{PROJ}/visuals/{ISSUE}-{slug}.html
  ~/.roxabi/forge/{PROJ}/visuals/css/{ISSUE}-{slug}.css
  ~/.roxabi/forge/{PROJ}/visuals/js/{ISSUE}-{slug}.js
  ~/.roxabi/forge/{PROJ}/visuals/tabs/{ISSUE}-{slug}/tab-*.html

Serve:   cd ~/.roxabi/forge/{PROJ}/visuals && python3 -m http.server 8080
         → http://localhost:8080/{ISSUE}-{slug}.html

Deploy:  cd ~/projects/lyra-stack && make diagrams deploy
```

$ARGUMENTS
