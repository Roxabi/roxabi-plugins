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

## Design Phase — Frame → Structure → Style → Deliver

Decisions made across Phases 1–4 follow this lens. It is an overlay on the procedural phases, not a separate pre-phase: Frame runs in Phase 1 (context), Structure in Phase 2 (epic structure / tab set), Style in Phase 3 (generate), Deliver in Phase 4 (report + verify).

### Track selection (Phase 1 start)

Run the brand book loader (`${CLAUDE_PLUGIN_ROOT}/references/brand-book-loader.md`) before any other decision:

- **Track A (branded)** — `forge.yml` found in project `brand/` → aesthetic/palette/typography locked; `deliver_must_match` rules enforced at Deliver.
- **Track B (exploration)** — no brand book → full Frame judgment.

Full track-by-track behavior: `${CLAUDE_PLUGIN_ROOT}/references/design-phase-two-track.md`.

Report the loaded brand book (or its absence) before starting Frame. Track is fixed at Phase 1 and does not change.

### Frame — What's this visual for?

Full reference: `${CLAUDE_PLUGIN_ROOT}/references/frame-phase.md` — three Frame questions, reader-action matrix, tone dimensions, example trace.

**For forge-epic specifically, Q1 (reader-action) is the most useful prompt.** An epic preview is read by contributors (who need scope + dependencies) OR by stakeholders (who need status + next milestone) OR by reviewers during acceptance (who need criteria). The same issue produces different tab sets for different readers. Commit to one reader before picking tabs.

- **Track A:** ask Q1 (reader-action) and Q2 (takeaway). **Skip Q3 (tone)** — tone is pre-constrained by brand voice rules.
- **Track B:** ask Q1, Q2, and full Q3.

Aesthetic is never chosen by Frame — it's mechanical (see `forge-ops.md § Aesthetic Detection`). Frame produces purpose, not CSS.

### Structure — Which tabs?

| Epic scope | Tabs | Rationale |
|---|---|---|
| Large feature (spec + impl) | `overview`, `breakdown`, `deps`, `criteria` | Full context needed |
| Medium feature | `overview`, `deps`, `criteria` | Skip breakdown if ≤3 tasks |
| Small fix / refactor | `overview`, `criteria` | Minimal, focused |

**Ask:** How complex is the issue? Multi-milestone → all tabs. Simple fix → overview + criteria only.

The four tab IDs above (`overview`, `breakdown`, `deps`, `criteria`) are the only ones the epic shell supports today. Do not invent new tab IDs without adding the matching tab fragment pattern in Phase 3.

### Style — Which components?

All classes below exist in `base/components.css` + `base/explainer-base.css`, or are defined inline in Phase 3 under `{EXTRA_STYLES}`.

| Tab | Components |
|---|---|
| Overview | `.epic-hero` (inline — see Phase 3) + `.cards` grid with `.card.accent` |
| Breakdown | `.cards` grid or `.table-wrap > table` with `.status.done/wip/todo` badges (inline styles — see Phase 3) |
| Deps | Mermaid flowchart in `.diagram-shell` with zoom controls |
| Criteria | `.table-wrap > table` — checklist with status column |

**Ask:** What visual signals does the reader need? Progress → status badges. Dependencies → Mermaid. Acceptance → checklist.

### Deliver — Generate + verify

**Always** (both tracks):
- `.epic-hero` shows issue number prominently.
- Status badges use correct colors (green `done`, amber `wip`, cyan `todo`) via the inline `.status` styles in Phase 3.
- Mermaid dep diagram wrapped in `.diagram-shell` — never bare `<pre class="mermaid">`.
- **Body copy uses `var(--text)` for maximum readability on dark backgrounds.** `var(--text-muted)` is for intermediate emphasis only (subtitles, label rows); `var(--text-dim)` is for metadata only.
- `diagram:issue` meta tag present and matches filename.
- No ASCII art, no emoji in headers.
- Tab buttons have `role="tab"` + `aria-selected` semantics.
- Interactive controls (theme toggle, zoom, tab buttons) have visible `:focus-visible` styling.
- Verify Frame Q2 takeaway is visible in the Overview tab — the reader should know the epic's one goal within 10 seconds.

**Track A additionally:**
- Run every `brand.deliver_must_match` rule against the generated tab fragments and shell. Report pass/fail per rule with the tab/line location. Do not write any file until all rules pass or the user overrides.
- If `brand.examples` list is non-empty, offer to visually diff the generated output against one canonical example.

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

3. **Run the brand book loader** (`${CLAUDE_PLUGIN_ROOT}/references/brand-book-loader.md`): Discovery → Parse → Apply. Determine Track A or Track B. Report the result before continuing.

4. **Slug** from ARGS title or issue title (kebab-case). Filename: `{ISSUE}-{slug}.html`.
   Check: `ls ~/.roxabi/forge/{PROJ}/visuals/{ISSUE}-*.html 2>/dev/null`
   ∃ → offer to update or create a new version.

5. **Read issue context** if accessible:
   - Check `~/projects/{PROJ}/` for relevant CLAUDE.md, specs, or any `docs/` referencing `#{ISSUE}`
   - Check git log: `cd ~/projects/{PROJ} && git log --oneline --grep="#{ISSUE}" 2>/dev/null | head -10`

6. **Apply the Aesthetic Detection precedence algorithm** (see `${CLAUDE_PLUGIN_ROOT}/references/forge-ops.md` § Aesthetic Detection) to select the correct aesthetic file.

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
