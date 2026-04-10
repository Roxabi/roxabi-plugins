---
name: forge-guide
description: 'Create a split-file multi-tab HTML document — user guide, architecture overview, project recap, comparison analysis, roadmap, or any rich multi-section doc. Triggers: "document" | "explain" | "illustrate" | "write a guide" | "create a guide" | "create a doc" | "make a recap" | "document this".'
version: 0.3.0
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
${CLAUDE_PLUGIN_ROOT}/references/base/components.css — concatenate fourth
${CLAUDE_PLUGIN_ROOT}/references/base/explainer-base.css — concatenate fifth (visual explainer components)
${CLAUDE_PLUGIN_ROOT}/references/aesthetics/         — select one based on detection logic
${CLAUDE_PLUGIN_ROOT}/references/shells/split.html   — HTML template with placeholders
${CLAUDE_PLUGIN_ROOT}/references/base/tab-loader.js  — substitute {NAME}, then inline
${CLAUDE_PLUGIN_ROOT}/references/diagram-meta.md     — meta tag format + categories
${CLAUDE_PLUGIN_ROOT}/references/mermaid-guide.md    — only if a tab will contain a Mermaid diagram
```

**Directive: inline, never link** — `base/` and `aesthetics/` files are generation source, not runtime dependencies. Read → inline into output `<style>` block.

---

## Design Phase — Think → Structure → Style → Deliver

Before generating, apply design thinking to match content to visual form.

### Think — Which aesthetic? Why?

| Content type | Recommended aesthetic | Reason |
|--------------|----------------------|--------|
| Personal AI / agent docs | `lyra.css` | Warm amber, human tone |
| Brand / company docs | `roxabi.css` | Gold, professional |
| Technical architecture | `blueprint.css` | Clean lines, monospace, technical |
| CLI / terminal guides | `terminal.css` | Monospace-heavy, dark |
| Blog / editorial content | `editorial.css` | Serif titles, magazine feel |

**Ask:** What is the reader's mental state? Technical exploration → Blueprint. Narrative reading → Editorial. Brand showcase → Roxabi.

### Structure — Which rendering approach?

| Content | Rendering |
|---------|-----------|
| Flow / topology / > 8 nodes | Mermaid `flowchart` (dagre auto-layout) |
| Hub-and-spoke ≤ 6 peers with rich cards | fgraph (`graph-templates/`) |
| Stacked text-heavy pipelines | CSS Grid cards |
| Data comparison | HTML tables (≥4 rows or ≥3 cols) |
| Single-page audit / long-form | TOC sidebar layout |

**Ask:** Does the content have a natural shape? Linear → Mermaid. Radial → fgraph. Text blocks → Grid.

### Style — Which components?

| Doc type | Hero | Sections | Cards |
|----------|------|----------|-------|
| User guide | Left-border hero | Dot section labels | Info cards |
| Architecture | Elevated hero | Square labels | Tech cards |
| Status / recap | Stat-grid hero | Triangle labels | Phase cards |
| Audit / review | Elevated hero + badges | Dot labels | Finding cards (high/medium/low) |

**Ask:** What visual hierarchy does this need? Quick scan → Stat grid. Deep dive → Finding cards.

### Deliver — Generate + verify

After generation, verify against wow examples:
- Hero section present with eyebrow + title accent + subtitle?
- Section titles use `.section-title` class (not plain `<h2>`)?
- Mermaid in diagram shell (not bare `<pre class="mermaid">`)?
- Dark mode text uses semantic tokens (`var(--text-muted)`, `var(--text-dim)`)?
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
2. Concatenate base CSS files in order: `reset → layout → typography → components → explainer-base`
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

4. **Determine layout mode:**
   - **Standard multi-tab** — nav with tabs, panels switch on click
   - **Mono-page with TOC sidebar** — single panel with sticky TOC navigation (for audits, long-form docs)

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

### Header (REQUIRED for multi-tab)

Replace the plain nav title with a styled header:

```html
<header>
  <div class="header-eyebrow">{{EYEBROW}}</div>
  <h1>{{TITLE_PLAIN}} <span class="accent">{{TITLE_ACCENT}}</span></h1>
  <div class="header-subtitle">{{SUBTITLE}}</div>
  <div class="header-row">
    <span class="verdict-badge green">✓ {{BADGE_1}}</span>
    <span class="verdict-badge amber">⚠ {{BADGE_2}}</span>
  </div>
</header>
<nav class="topnav" aria-label="Main">
  <div class="tabs" role="tablist">
    {TABS}
  </div>
  <button class="theme-btn" id="theme-toggle" ...>◑ light</button>
</nav>
```

### TOC Sidebar (for mono-page guides)

For audit-style or long-form single-page docs, use the TOC sidebar layout:

```html
<div class="wrap--toc">
  <aside class="toc">
    <div class="toc-title">Contents</div>
    <a href="#overview">Overview</a>
    <a href="#section-1">1. Section Name</a>
    <a href="#section-2">2. Another Section</a>
  </aside>
  <main class="main--toc">
    <!-- content here -->
  </main>
</div>
```

Add TOC scroll observer to `{EXTRA_SCRIPTS}`:

```javascript
// TOC scroll observer
const tocLinks = document.querySelectorAll('.toc a')
const sections = document.querySelectorAll('.sec-head')
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      tocLinks.forEach(l => l.classList.remove('active'))
      const id = e.target.getAttribute('id')
      document.querySelector(`.toc a[href="#${id}"]`)?.classList.add('active')
    }
  })
}, { rootMargin: '-20% 0px -80% 0px' })
sections.forEach(s => observer.observe(s))
```

### Section Titles (REQUIRED)

Use styled section titles instead of plain `<h2>`:

```html
<div class="section-title">2.1 — Section Name</div>
```

Or with section label:

```html
<div class="section-label dot">1.1</div>
<h2>Section Name</h2>
```

### Finding Cards (for audit-style content)

For code/design reviews, use finding cards with severity:

```html
<div class="finding finding--high">
  <div class="finding-header">
    <span class="badge badge--risk high">HIGH</span>
    <span class="finding-title">{{ISSUE_TITLE}}</span>
  </div>
  <div class="finding-body">{{DESCRIPTION}}</div>
  <div class="finding-files"><code>{{FILE_NAME}}</code></div>
</div>
```

Severity levels: `finding--high` (red), `finding--medium` (amber), `finding--low` (cyan).

### Stat Grid (for overview tabs)

```html
<div class="stat-grid">
  <div class="stat">
    <span class="stat__value">{{NUMBER}}</span>
    <span class="stat__label">{{LABEL}}</span>
  </div>
</div>
```

### Diagram Shell (REQUIRED for Mermaid tabs)

**NEVER use bare `<pre class="mermaid">`.** Always wrap in the diagram shell:

```html
<div class="diagram-shell">
  <div class="zoom-controls">
    <button data-zoom="in" title="Zoom in">+</button>
    <button data-zoom="fit" title="Fit">⤢</button>
    <button data-zoom="out" title="Zoom out">−</button>
  </div>
  <div class="mermaid-container" data-mermaid-out id="diagram-{{TAB_ID}}"></div>
  <script type="text/plain" data-mermaid>
    {{MERMAID_SOURCE}}
  </script>
</div>
```

See `references/mermaid-guide.md` for the full checklist on dynamic tab rendering.

### Tab fragments — content patterns by tab type:

| Tab type | Content |
|----------|---------|
| Overview / intro | Header + `<p>` + `.stat-grid` + `.cards` grid (2–4 cards) |
| Step-by-step | Section titles + `<ol>` + `<pre><code>` |
| Architecture | Section title + Mermaid diagram (in shell) + description |
| Comparison | Section title + `.table-wrap > table` with `<thead>` |
| Status / KPIs | Section title + `.stat-grid` + progress indicators |
| Decisions / log | `<h3>` entries with date + rationale `<p>` |
| Audit / Review | TOC sidebar + `.finding` cards by severity |

**Dark mode text — always:**
- Paragraphs, list items, card body → `color: var(--text-muted)` (`#9ca3af`)
- Column headers, dates, metadata → `color: var(--text-dim)` (`#6b7280`)

---

## Anti-Patterns (FORBIDDEN)

| Anti-Pattern | Fix |
|--------------|-----|
| Bare `<pre class="mermaid">` | Use diagram shell with `.mermaid-wrap` |
| ASCII art in `<pre class="arch">` | Convert to Mermaid flowchart or fgraph |
| Emoji in headers | Remove — use text only |
| `rgba()` in Mermaid `style` directives | Use hex colors only |
| `theme: 'dark'` in Mermaid config | Use `theme: 'base'` + custom `themeVariables` |
| Plain `<h2>` for section titles | Use `.section-title` class |
| No header on multi-tab | Add styled header with eyebrow + badges |
| Plain nav title only | Replace with full header component |

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
