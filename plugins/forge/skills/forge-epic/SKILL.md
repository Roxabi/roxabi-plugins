---
name: forge-epic
description: 'Create an issue/epic-linked visual analysis — overview, scope breakdown, dependency graph, acceptance criteria. Filename always includes the issue number. Triggers: "visualize #N" | "preview #N" | "illustrate issue" | "map issue" | "epic preview" | "show epic".'
version: 0.2.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch
---

# Epic — Issue-Linked Visual Analysis

Create a visual analysis document tied to a specific GitHub issue or epic (`#N`).

Output: `~/.roxabi/forge/<project>/visuals/{N}-{slug}.html` (split-file).

**Read before generating:**

```
${CLAUDE_PLUGIN_ROOT}/references/forge-ops.md        — brand detection, output paths, deploy commands
${CLAUDE_PLUGIN_ROOT}/references/base/reset.css      — concatenate first
${CLAUDE_PLUGIN_ROOT}/references/base/layout.css     — concatenate second
${CLAUDE_PLUGIN_ROOT}/references/base/typography.css — concatenate third
${CLAUDE_PLUGIN_ROOT}/references/base/components.css — concatenate last
${CLAUDE_PLUGIN_ROOT}/references/aesthetics/         — select one based on detection logic
${CLAUDE_PLUGIN_ROOT}/references/shells/split.html   — HTML template with placeholders
${CLAUDE_PLUGIN_ROOT}/references/base/tab-loader.js  — substitute {NAME}, then inline
${CLAUDE_PLUGIN_ROOT}/references/diagram-meta.md     — meta tag format + categories
${CLAUDE_PLUGIN_ROOT}/references/mermaid-guide.md    — dependency/breakdown diagrams
```

**Directive: inline, never link** — `base/` and `aesthetics/` files are generation source, not runtime dependencies. Read → inline into output `<style>` block.

---

## Design Phase — Think → Structure → Style → Deliver

Before generating, apply design thinking to match content to visual form.

### Think — Which aesthetic? Why?

| Epic type | Recommended aesthetic | Reason |
|-----------|----------------------|--------|
| Feature implementation | `blueprint.css` | Technical, clean for scope breakdown |
| Brand / UX work | `roxabi.css` | Gold for design epics |
| Personal AI features | `lyra.css` | Amber, warm for agent work |
| Refactor / maintenance | `terminal.css` | Monospace, code-focused |

**Ask:** What is the issue about? Technical implementation → Blueprint. Design/brand → Roxabi. Agent features → Lyra.

### Structure — Which tabs?

| Epic scope | Tabs | Rationale |
|-----------|------|-----------|
| Large feature (spec + impl) | `overview`, `breakdown`, `deps`, `criteria` | Full context needed |
| Medium feature | `overview`, `deps`, `criteria` | Skip breakdown if ≤3 tasks |
| Small fix / refactor | `overview`, `criteria` | Minimal, focused |
| Research / investigation | `overview`, `findings`, `next` | No deps tab, add findings |

**Ask:** How complex is the issue? Multi-milestone → All tabs. Simple fix → Overview + criteria only.

### Style — Which components?

| Tab | Components |
|-----|------------|
| Overview | Epic hero (issue number + title + goal) + scope cards |
| Breakdown | Cards grid OR table with status badges (done/wip/todo) |
| Deps | Mermaid flowchart in diagram shell + zoom controls |
| Criteria | Checklist table with status column |
| Findings | Finding cards (high/medium/low severity) |

**Ask:** What visual signals does the reader need? Progress → Status badges. Risk → Finding cards. Dependencies → Mermaid.

### Deliver — Generate + verify

After generation, verify:
- Epic hero shows issue number prominently?
- Status badges use correct colors (green done, amber wip, cyan todo)?
- Mermaid dep diagram in shell with zoom controls?
- Dark mode text uses semantic tokens?
- diagram:issue meta tag present?
- No ASCII art, no emoji in headers?

---

## Aesthetic Detection

| Priority | Signal | Aesthetic |
|----------|--------|-----------|
| 1 | Explicit `--aesthetic` arg | As specified |
| 2 | Brand book found (`BRAND-BOOK.md`) | Derived from palette |
| 3 | Project = `lyra` / `voicecli` | `lyra.css` |
| 4 | Project = `roxabi*` / `2ndBrain` | `roxabi.css` |
| 5 | Content = architecture / spec | `blueprint.css` |
| 6 | Content = CLI / terminal doc | `terminal.css` |
| 7 | Default | `editorial.css` |

---

## Shell Processing

1. Read `shells/split.html` template
2. Concatenate base CSS files in order: `reset → layout → typography → components`
3. Read selected aesthetic CSS
4. Read `base/tab-loader.js`, substitute `{NAME}` with `{ISSUE}-{slug}`
5. Substitute placeholders:
   - `{NAME}` → `{ISSUE}-{slug}` (for localStorage key scoping + tab-loader.js)
   - `{BASE_STYLES}` → concatenated base CSS
   - `{AESTHETIC_STYLES}` → selected aesthetic CSS
   - `{TITLE}` → `{PROJ} #{ISSUE} — {Short Title}` (e.g. "Lyra #477 — Tool Registry")
   - `{DATE}`, `{CATEGORY}`, `{CAT_LABEL}`, `{COLOR}`, `{BADGES}` → diagram metadata
   - `{TABS}` → tab button elements (one per tab)
   - `{PANELS}` → panel container elements (one per tab)
   - `{TAB_LOADER_JS}` → tab-loader.js with `{NAME}` substituted
   - `{HEAD_EXTRAS}` → optional (e.g., svg-pan-zoom CDN for Mermaid)
   - `{EXTRA_STYLES}` → epic-specific CSS (epic-hero, status badges, etc.)
   - `{EXTRA_SCRIPTS}` → optional (e.g., mermaid-init.js)
6. Output: split-file HTML (requires HTTP serve)

Let:
  ARGS   := $ARGUMENTS
  ISSUE  := GitHub issue number (required — extract from ARGS or ask)
  AG     := `~/.roxabi/forge/`

---

## Phase 1 — Context

1. **Extract issue number** from ARGS (e.g. `#477`, `477`, "issue 477"). Not found → DP(B): "Which issue number is this epic for?"

2. **Detect project** from ARGS or cwd.

3. **Brand book** — follow `forge-ops.md` brand detection.

4. **Slug** from ARGS title or issue title (kebab-case). Filename: `{ISSUE}-{slug}.html`.
   Check: `ls ~/.roxabi/forge/{PROJ}/visuals/{ISSUE}-*.html 2>/dev/null`
   ∃ → offer to update or create a new version.

5. **Read issue context** if accessible:
   - Check `~/projects/{PROJ}/` for relevant CLAUDE.md, specs, or any `docs/` referencing `#{ISSUE}`
   - Check git log: `cd ~/projects/{PROJ} && git log --oneline --grep="#{ISSUE}" 2>/dev/null | head -10`

6. **Apply aesthetic detection logic** to select the correct aesthetic file.

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

Read `shells/split.html` → substitute placeholders. The shell contains all structure.

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

CSS for epic-hero (add to `{EXTRA_STYLES}`):
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
.status.done { background: var(--success-dim); color: var(--success); }
.status.wip  { background: var(--warning-dim); color: var(--warning); }
.status.todo { background: var(--info-dim); color: var(--info); }
```

**Deps tab** — Mermaid dependency diagram. Follow `references/mermaid-guide.md` checklist exactly (dynamic tab pitfalls).

**Acceptance criteria tab** — table: | Criterion | Type | Status |

Dark mode text rules always apply — use semantic tokens from `base/components.css`.

---

## Phase 4 — Report

```
Created:
  ~/.roxabi/forge/{PROJ}/visuals/{ISSUE}-{slug}.html
  ~/.roxabi/forge/{PROJ}/visuals/css/{ISSUE}-{slug}.css
  ~/.roxabi/forge/{PROJ}/visuals/js/{ISSUE}-{slug}.js
  ~/.roxabi/forge/{PROJ}/visuals/tabs/{ISSUE}-{slug}/tab-*.html

Serve + Deploy: see forge-ops.md
```

$ARGUMENTS
