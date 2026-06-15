---
title: Comprehensive Codebase Documentation Playbook
description: Generate a full HTML documentation site for any open-source project using parallel sub-agents
purpose: Create production-quality documentation from zero in a single session
scope: Open-source projects, documented codebases, projects needing comprehensive docs
dependencies:
  - Claude Code with sub-agent support
  - Target repo cloned locally
  - "~/.agent/<project>/ directory for output"
  - ui-ux-pro-max skill
  - web-design-guidelines skill
  - frontend-design skill
tags:
  - documentation
  - html
  - parallel-agents
  - open-source
  - codebase-analysis
version: "1.0"
last_updated: "2026-04-28"
---

# Playbook: Comprehensive Codebase Documentation

> Generate a full HTML documentation site for any open-source project — from zero to production-quality — using parallel sub-agents at every stage.

**Proven on:** OpenClaw (10K files, 336KB final doc, ~23 agents, one session)

---

## Prerequisites

- Claude Code with sub-agent support
- Target repo cloned locally
- `~/.agent/<project>/` directory for output (per exploration artifacts convention)
- Skills installed: `ui-ux-pro-max`, `web-design-guidelines`, `frontend-design`

---

## Phase 1: Deep Scan (3 parallel agents)

**Goal:** Understand the entire codebase before writing a single line.

| Agent | Focus | What to extract |
|-------|-------|-----------------|
| **Structure scanner** | Top-level layout | Directory tree (3 levels), README, CLAUDE.md, package.json, config files, git log, file counts by type |
| **Core/agent scanner** | Architecture internals | Entry points, main loop, tool system, memory, LLM integration, identity/soul/persona, plugin system |
| **Features scanner** | All capabilities | Channels, RAG, web search, browser, code execution, image/voice, task management, DB, API, auth, cron, deployment |

### Prompt template:
```
Very thoroughly explore /path/to/repo for [FOCUS AREA]. I need to understand:
1. [specific question]
2. [specific question]
...
Read every key source file you find. Be extremely thorough.
```

### Output: Initial .md documentation draft
Write a single Markdown file with all sections identified. This becomes the content source for everything that follows.

---

## Phase 2: Validate & Research (4 parallel agents)

**Goal:** Verify the draft AND gather brand assets simultaneously. These are independent — run them all at once.

| Agent | Type | Mission |
|-------|------|---------|
| **Product lead** | `dev-core:product-lead` | Verify features, find gaps vs README/VISION, assess user journey, identify missing sections |
| **Architect** | `dev-core:architect` | Verify architecture claims against source code, map data flows, validate diagram inputs |
| **Repo brand scanner** | `Explore` | Search assets/, ui/, apps/ for SVGs, CSS themes, color definitions. Extract hex values, logo paths |
| **Web brand researcher** | `general-purpose` | Search for official website, docs site CSS, GitHub org page. Get brand tokens |

### Key instruction for reviewers:
```
Read the key source files. Return:
- Verified facts (with file paths)
- New discoveries I missed
- Gaps that need filling
- Recommended changes to the structure
```

### Brand data needed:
- Primary/secondary accent colors (dark + light variants)
- Background surface layers (dark + light)
- Text colors (primary, dim, faint)
- Logo SVG path data
- Font stack (heading, body, mono)

### Output: Revised section structure + brand palette
Consolidate into final tab list with reviewer sign-off and complete color/font spec.

---

## Phase 3: Build (7 parallel agents)

**Goal:** Create all files simultaneously. This is the core parallelization win.

### File structure:
```
~/.agent/<project>/
  <project>-docs.html       # Shell: nav, hero, tabs, footer
  css/<project>-docs.css     # Design system
  js/<project>-docs.js       # Behavior
  tabs/
    tab-<section>.html       # One per tab (lazy-loaded fragments)
```

### Agent allocation:

| Agent | Creates | Notes |
|-------|---------|-------|
| **CSS builder** | `css/<project>-docs.css` | Fork v14 design system, swap palette, keep all component classes |
| **HTML+JS builder** | Shell HTML + JS | Nav, animated hero SVG, tab bar, reading guide, footer, theme toggle, lazy loading, glitch text, ARIA |
| **Tab batch 1** | 2 tabs (overview + architecture) | Architecture gets SVG diagrams — heaviest tab |
| **Tab batch 2** | 2 tabs (soul/identity + memory) | Memory gets SVG pipeline diagram |
| **Tab batch 3** | 2 tabs (channels + models) | Data-heavy tables |
| **Tab batch 4** | 2 tabs (tools + plugins) | Code examples, API tables |
| **Tab batch 5** | 3 tabs (automation + nodes + security) | Heaviest batch — consider splitting if >3 tabs |

### Build-time requirements (include in every agent prompt):

These prevent the most common review findings. Bake them in at build time:

<details>
<summary><strong>HTML shell requirements</strong></summary>

- `<a class="skip-link" href="#main">Skip to content</a>` as first child of `<body>`
- `<meta name="theme-color" content="...">` in `<head>`
- Pre-populated `<h1>` text (JS glitch effect enhances, doesn't replace)
- `aria-live="polite"` on every tab panel
- SVG icons for structural elements (never emojis)
- `role="alert"` on error states
</details>

<details>
<summary><strong>CSS requirements</strong></summary>

- `color-scheme: dark` / `color-scheme: light` on theme variants
- `:active` states on all interactive elements
- `:focus:not(:focus-visible)` pattern (not blanket `outline: none`)
- `touch-action: manipulation` on interactive elements
- `scroll-behavior: smooth` gated behind `prefers-reduced-motion: no-preference`
- `scroll-margin-top` on headings (accounting for fixed nav + tabs)
- `text-wrap: balance` on headings, `font-variant-numeric: tabular-nums` on numbers
- Skip-link styles (off-screen by default, visible on `:focus`)
- Light mode must retain brand atmosphere (warm/tinted bg, not cold white)
- Never use `transition: all` — always explicit property lists
</details>

<details>
<summary><strong>JS requirements</strong></summary>

- Theme toggle must update `aria-label` and `<meta name="theme-color">` dynamically
- Tab loading must set `aria-busy="true"` during fetch; errors use `role="alert"`
- `history.pushState` + `popstate` (not `replaceState` + `hashchange`)
- `IntersectionObserver` to pause hero animations when off-screen
- Focus only moves to panel on explicit user-initiated tab switch
</details>

### Tab builder prompt template:
```
Create HTML FRAGMENTS (no DOCTYPE/head/body) loaded via fetch().

CSS component vocabulary:
  .page-title / .page-sub, .section-title, .card / .grid2-4,
  .tbl-wrap > table.tbl, .cb > .cb-head + pre, .ib.note/.warn/.tip,
  .flow > .fn + .fa, .diagram-wrap, .steps > .step, .badge variants

Rules: SVG icons (not emojis), <ol> for sequences, role="img" + aria-label on SVGs

[EXACT CONTENT SPEC FOR EACH TAB]
```

**Critical:** Spell out every section, table, and diagram. Agents with vague specs produce vague output.

---

## Phase 4: Full Review (6 parallel agents)

**Goal:** All reviewers run simultaneously on the built artifact — content accuracy, design quality, and accessibility in one pass. This is the key optimization: six independent lenses, zero sequential dependency.

### Content reviewers (3 agents):

| Agent | Type | Focus |
|-------|------|-------|
| **Doc writer** | `dev-core:doc-writer` | CSS class usage consistency, typos, component correctness |
| **Product lead** | `dev-core:product-lead` | User journey, feature completeness vs repo, CTA effectiveness |
| **Architect** | `dev-core:architect` | Technical accuracy vs source code, diagram correctness, factual errors |

### Design & accessibility reviewers (3 skill agents):

| Agent | Skill | Focus |
|-------|-------|-------|
| **UI/UX reviewer** | `/ui-ux-pro-max` | WCAG AA contrast, touch targets, focus/`:active` states, animation performance, interaction completeness |
| **Web guidelines reviewer** | `/web-design-guidelines` | Progressive enhancement, ARIA compliance, `color-scheme`, `transition: all`, `prefers-reduced-motion`, semantic HTML, skip links |
| **Frontend design reviewer** | `/frontend-design` | Font pairing (declared vs loaded), type scale, light mode brand retention, card hover effects, code architecture |

### Key instructions:
```
# For content reviewers:
Cross-reference against actual source code. Specifically check: [file list]
Return: ERRORS, GAPS, IMPROVEMENTS, VERIFIED

# For design reviewers:
Read ALL source files (HTML, CSS, JS, 2-3 sample tabs).
Return: Category, Severity (CRITICAL/HIGH/MEDIUM/LOW), file:line, concrete fix.
DO NOT write code — only produce the review.
```

### Output: Single unified issue list
Deduplicate across all 6 reports (they overlap on contrast, focus, motion) and tier:
- **Tier 1 — Must fix:** Factual errors, rendering breaks, CRITICAL a11y (skip link, contrast, aria-live)
- **Tier 2 — Should fix:** Product gaps, HIGH design issues (`:active`, `color-scheme`, font loading)
- **Tier 3 — Nice to have:** Polish (`text-wrap: balance`, `tabular-nums`, type scale)

### Residual findings to expect (even with build-time requirements):

Build agents produce ~80% of requirements correctly. These slip through every time:

| Finding | Why it persists | Fix |
|---------|----------------|-----|
| `transition: all .2s` | CSS shorthand habit | Explicit property lists |
| `--textfaint` fails WCAG AA | Dim text too dim on dark bg | Raise to 4.5:1 |
| `.tab-group-label` invisible | Color + opacity stacked | Remove opacity |
| Light mode = cold white | Agent defaults to `#fcfeff` | Warm-tint: `#fef8f6` |
| Fonts declared but not loaded | Different agents wrote CSS and HTML | Remove from stack or load |
| Dead CSS with no JS handler | CSS defines `.collapsed`, JS never wires it | Add handler or remove CSS |

---

## Phase 5: Fix (up to 8 parallel agents)

**Goal:** Apply all findings — content, design, and a11y — in one pass.

### Backup first:
```bash
cp -r ~/.agent/<project>/ ~/.agent/<project>-pre-fix/
```

### Group by file independence:

| Agent | Files | Fix categories |
|-------|-------|---------------|
| **Shell fixer** | HTML + CSS + JS | Sequential: HTML first (skip link, meta, aria-live, SVG icons) → CSS (contrast, transitions, `:active`, touch targets, light mode, reduced motion) → JS (aria-label, IntersectionObserver, pushState, focus, collapse handlers) |
| **Tab fixer 1** | tab-overview | Content reordering, factual fixes |
| **Tab fixer 2** | tab-arch | Diagram corrections, accuracy |
| **Tab fixer 3** | tab-A + tab-B | Related fixes across 2 tabs |
| **Tab fixer N** | ... | ... |

The **shell fixer** works sequentially (HTML/CSS/JS have inter-dependencies). Tab fixers run in parallel with each other and with the shell fixer.

### Key instruction for fixers:
```
Fix these specific issues in [file]. Read the file first, then apply fixes.
## Fix 1: [exact description]
- PROBLEM: [what's wrong]
- FIX: [exact change to make, with code if needed]
```

**Never:** Ask a fixer to "review and fix what you find." Always give exact specs.

---

## Checklist

```
[ ] Phase 1: 3 scan agents → initial .md draft
[ ] Phase 2: 4 agents (2 reviewers + 2 brand) → validated structure + palette
[ ] Phase 3: 7 build agents → all files created in parallel
[ ] Phase 4: 6 review agents → unified issue list (content + design + a11y)
[ ] Phase 5: up to 8 fix agents → all issues resolved
[ ] Serve: python3 -m http.server 8787
[ ] Final check: dark mode, light mode, keyboard-only, reduced-motion
```

---

## Tips & Lessons Learned

### Parallelization
- **Independent files = parallel agents.** CSS, JS, and each tab have zero dependencies.
- **All 6 reviewers run at once.** Content and design reviewers are fully independent.
- **Shell fixer is sequential** (HTML → CSS → JS due to class/selector/ID dependencies). Tab fixers are parallel.
- **3 tabs max per build agent.** Quality drops beyond that.
- Batch tabs by complexity — architecture (SVG diagrams) is 2-3x heavier than a table tab.

### Prompt precision
- Give build agents the **exact CSS class names**. Don't make them guess.
- Give tab agents the **exact content** for each section (tables, flows, diagrams).
- For SVG diagrams: specify viewBox, color palette, font families, component names.
- For review agents: "DO NOT write code — only produce the review." Prevents premature fixes.

### Class mismatches
When CSS and HTML are built by different agents, class names WILL diverge. The review phase catches these:
- Loader/animation class renames (agent rebrands in one file only)
- Badge modifier classes (`badge-green` in tabs, `badge.builtin` in CSS)
- Footer/nav wrapper naming

### Architect review is non-negotiable
Without source code verification, ~30% of architectural claims were wrong (hook names, thresholds, tool names). The architect agent with explicit file paths caught every one.

### Design/a11y review is also non-negotiable
Content reviewers miss ~40 design issues. Only the skill agents catch:
- **Contrast math** — can't compute WCAG ratios by eye
- **`transition: all`** — looks fine in code, flagged as anti-pattern
- **Progressive enhancement** — nobody checks "what if JS fails?"
- **Font loading gaps** — CSS declares fonts that HTML never loads
- **Dead interactions** — CSS defines states, JS never wires the handler

### Cost structure
- Scan: ~3 agents, light
- Validate + brand: ~4 agents, medium
- Build: ~7 agents, heavy (bulk of tokens)
- Review: ~6 agents, heavy (reads all files + source + guidelines)
- Fix: ~3-8 agents, medium
- **Total: ~23-28 agents per project**
