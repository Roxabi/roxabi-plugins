---
name: forge-guide
description: 'Create a split-file multi-tab HTML document — user guide, architecture overview, project recap, comparison analysis, roadmap, or any rich multi-section doc. Triggers: "document" | "explain" | "illustrate" | "write a guide" | "create a guide" | "create a doc" | "make a recap" | "document this".'
version: 0.1.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, ToolSearch
---

# Guide — Split-File Multi-Tab Document

Create any rich multi-section HTML document as a split-file: shell HTML + CSS + JS + tab fragments.
Output: `~/.roxabi/forge/<project>/visuals/` (exploration) or `~/projects/<project>/docs/visuals/` (final).

Covers: user guides, architecture overviews, project recaps, analysis/comparison matrices, roadmaps, feature plans, review reports.

**Read before generating:**

```
${CLAUDE_PLUGIN_ROOT}/references/forge-ops.md     — brand detection, output paths, deploy commands
${CLAUDE_PLUGIN_ROOT}/references/split-file.md    — templates + CSS/JS skeletons
${CLAUDE_PLUGIN_ROOT}/references/aesthetics/      — lyra.css, roxabi.css (copy full token blocks)
${CLAUDE_PLUGIN_ROOT}/references/diagram-meta.md  — meta tag format + categories
${CLAUDE_PLUGIN_ROOT}/references/mermaid-guide.md — only if a tab will contain a Mermaid diagram
```

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

Use exact templates from `references/split-file.md`. Replace all `{PLACEHOLDER}` values.

**Shell HTML:** diagram-meta block, Google Fonts link, CSS link, nav with tab buttons + theme toggle, panel placeholders, JS script.

**CSS:** token block (copy from `references/aesthetics/{project}.css`) + full skeleton.

**JS:** IIFE with theme, `loadPanel`, `activate`. Add `window.__postLoad` + `window.__initPanZoom` if Mermaid tabs exist (from `references/mermaid-guide.md`).

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
