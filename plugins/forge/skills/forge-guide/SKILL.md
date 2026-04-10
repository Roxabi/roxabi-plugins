---
name: forge-guide
description: 'Create a split-file multi-tab HTML document — user guide, architecture overview, project recap, comparison analysis, roadmap, or any rich multi-section doc. Triggers: "document" | "explain" | "illustrate" | "write a guide" | "create a guide" | "create a doc" | "make a recap" | "document this".'
version: 0.2.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch
---

# Guide — Split-File Multi-Tab Document

Create any rich multi-section HTML document as a split-file: shell HTML + CSS + JS + tab fragments.
Output: `~/.roxabi/forge/<project>/visuals/` (exploration) or `~/projects/<project>/docs/visuals/` (final).

Covers: user guides, architecture overviews, project recaps, analysis/comparison matrices, roadmaps, feature plans, review reports.

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
${CLAUDE_PLUGIN_ROOT}/references/mermaid-guide.md    — only if a tab will contain a Mermaid diagram
```

**Directive: inline, never link** — `base/` and `aesthetics/` files are generation source, not runtime dependencies. Read → inline into output `<style>` block.

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
4. Read `base/tab-loader.js`, substitute `{NAME}` with diagram slug
5. Substitute placeholders:
   - `{NAME}` → diagram slug (for localStorage key scoping + tab-loader.js)
   - `{BASE_STYLES}` → concatenated base CSS
   - `{AESTHETIC_STYLES}` → aesthetic CSS (editorial.css if default)
   - `{TITLE}`, `{DATE}`, `{CATEGORY}`, `{CAT_LABEL}`, `{COLOR}`, `{BADGES}` → diagram metadata
   - `{TABS}` → tab button elements (one per tab)
   - `{PANELS}` → panel container elements (one per tab)
   - `{TAB_LOADER_JS}` → tab-loader.js with `{NAME}` substituted
   - `{HEAD_EXTRAS}` → optional (e.g., svg-pan-zoom CDN for Mermaid)
   - `{EXTRA_STYLES}` → guide-specific CSS additions (if any)
   - `{EXTRA_SCRIPTS}` → optional (e.g., mermaid-init.js)
6. Output: split-file HTML (requires HTTP serve)

Let:
  ARGS := $ARGUMENTS
  AG   := `~/.roxabi/forge/`

---

## Phase 1 — Context Discovery

1. **Detect project** from ARGS or cwd. Unknown → DP(B). (See `forge-ops.md` for detection signals.)

2. **Brand book** — follow `forge-ops.md` brand detection.

3. **Output root** — follow `forge-ops.md` output paths.

4. **Slug** (kebab-case ≤30 chars). Check existing versions:
   ```bash
   ls {ROOT}/{SLUG}*.html 2>/dev/null
   ```
   ∃ v<N> → propose vN+1 and offer to mark old version `archived` in its meta.

5. **Apply aesthetic detection logic** to select the correct aesthetic file.

---

## Phase 2 — Structure

1. **Choose `diagram:category`** based on content type (from `references/diagram-meta.md`):
   - User guide / tutorial → `guide`
   - Architecture / system design → `architecture`
   - Comparison / competitive analysis → `analysis`
   - Roadmap / implementation plan → `plan`
   - Status update / progress summary → `recap`
   - Code / design audit → `review`

2. **Plan tabs.** Propose from ARGS topic + confirm. Common sets:

   | Doc type | Typical tabs |
   |----------|-------------|
   | User guide | qs, setup, usage, agents, voice, architecture |
   | Architecture | overview, components, flow, deployment |
   | Analysis / comparison | overview, matrix, gaps, verdict |
   | Recap / status | summary, progress, decisions, next |
   | Roadmap | overview, phases, deps, risks |

3. **Note Mermaid tabs** — if any tab needs a diagram, follow `references/mermaid-guide.md` checklist.

---

## Phase 3 — Generate

**File paths:**
```
{ROOT}/{SLUG}.html
{ROOT}/css/{SLUG}.css
{ROOT}/js/{SLUG}.js
{ROOT}/tabs/{SLUG}/tab-{ID}.html    ← one per tab
```

Read `shells/split.html` → substitute placeholders. The shell contains all structure.

**Shell HTML:** diagram-meta block, Google Fonts link, CSS link, nav with tab buttons + theme toggle, panel placeholders, JS script.

**CSS file:** write `{BASE_STYLES}` (concatenated base CSS) + `{AESTHETIC_STYLES}` (aesthetic CSS) + any guide-specific styles to `{ROOT}/css/{SLUG}.css`.

**JS file:** write `{TAB_LOADER_JS}` (tab-loader.js with `{NAME}` substituted) + Mermaid init (if needed) to `{ROOT}/js/{SLUG}.js`.

**Tab fragments** — content patterns by tab type:

| Tab type | Content |
|----------|---------|
| Overview / intro | `<h1>`, 1–2 `<p>`, `.cards` grid (2–4 cards) |
| Step-by-step | `<h2>` sections + `<ol>` + `<pre><code>` |
| Architecture | Mermaid diagram (checklist) + description |
| Comparison | `.table-wrap > table` with `<thead>` |
| Status / KPIs | `.cards` grid with stat cards |
| Decisions / log | `<h3>` entries with date + rationale `<p>` |

**Dark mode text — always:**
- Paragraphs, list items, card body → `color: var(--text-muted)` (`#9ca3af`)
- Column headers, dates, metadata → `color: var(--text-dim)` (`#6b7280`)

---

## Phase 4 — Report

```
Created:
  {ROOT}/{SLUG}.html
  {ROOT}/css/{SLUG}.css
  {ROOT}/js/{SLUG}.js
  {ROOT}/tabs/{SLUG}/tab-{ID}.html  (×N)

Serve + Deploy: see forge-ops.md
```

$ARGUMENTS
