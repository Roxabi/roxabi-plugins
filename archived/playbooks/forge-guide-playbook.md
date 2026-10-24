---
title: Forge Guide Playbook
description: From scattered markdown to deployed multi-tab HTML guide using parallel agents
purpose: Build a polished, interactive multi-tab educational guide with diagrams, deployed to forge — for any theme
scope:
  - Products needing onboarding/educational HTML guides
  - Multi-chapter knowledge bases (10-20 tabs)
  - Founder-facing or user-facing learning content with diagrams
dependencies:
  - dev-core agent types (product-lead, doc-writer)
  - forge plugin skills (forge-guide, forge-chart)
  - Cloudflare Pages account (via forge make deploy)
  - rsvg-convert (Flatpak GNOME runtime OR apt librsvg2-bin)
  - Playwright (uv + playwright)
tags:
  - educational-guide
  - multi-tab-html
  - parallel-agents
  - svg-diagrams
  - forge
  - cloudflare-pages
version: "1.0"
last_updated: "2026-05-20"
source: Built from idea-to-prod guide session (16 chapters, 29 SVGs, ~30 sub-agents)
---

# Forge Guide Playbook

**Source:** "Guide De l'idée à la production avec Claude Code" session — reconstructed as a reusable process.

**One-line:** Markdown content + visual identity → deployed multi-tab HTML guide with diagrams in 1 session via parallel agents.

---

## 1. Overview

This playbook describes an agent-orchestrated process that takes raw markdown content (or a content plan) and produces a polished, interactive HTML guide deployed to Cloudflare Pages — for any theme.

The output is:

- A multi-tab HTML guide (10-20 chapters) deployed at `forge.roxabi.dev/<project>/`
- N SVG diagrams (5-30 typically), Roxabi visual identity, semantic colors
- A post-mortem document capturing decisions and rework
- A reproducible source tree at `~/.roxabi/forge/<project>/`

**Time estimate:** 4-6 hours of operator attention. Agent work runs in parallel — bottleneck is decision gates.

**What this is NOT:** a free-form essay, a static blog post, or a single-page doc. For those, use simpler templates.

---

## 2. Prerequisites

### Required

- **Content plan or existing markdown** — at minimum a list of chapters with 1-paragraph each. Ideal: 10-20 markdown files with structured `## X.Y` headings.
- **Theme / target audience** — who reads this and what they need to learn.
- **Roxabi forge installed** — `~/.roxabi/forge/` exists with Makefile + `.env` (Cloudflare credentials).
- **Difficulty markers convention** — 🟢🟡🔴 per section is the de facto standard (Débutant/Intermédiaire/Avancé).

### Strongly recommended

- **Anti-patterns documented** — write up what your guide should NOT look like (e.g., walls of code, jargon without definition).
- **Diagrams inventory** — even a rough list "I'll need a sequence diagram for auth flow, a state machine for the issue lifecycle..." helps phase 2.

### Optional but high-value

- **Visual identity tokens** — design tokens already in the forge template (cyan/magenta accent + semantic colors green/amber/red).
- **Existing similar guides** — to learn from layout patterns.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       FORGE GUIDE PIPELINE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Phase 1: DISCOVERY ─ gap analysis + content plan validation                │
│        │                                                                     │
│        ▼                                                                     │
│   Phase 2: WIREFRAME ─ per-tab spec + fgraph type mapping (CRITICAL AUDIT)   │
│        │                                                                     │
│        ▼                                                                     │
│   Phase 3: SHELL ─ /forge:forge-guide → HTML + CSS + JS                      │
│        │                                                                     │
│        ▼                                                                     │
│   Phase 4: BENCHMARK ─ 1 ref SVG + visual QA + cleanup BEFORE mass-prod      │
│        │                                                                     │
│        ▼                                                                     │
│   Phase 5: MASS-PROD SVG ─ N parallel agents by visual cluster               │
│        │                                                                     │
│        ▼                                                                     │
│   Phase 6: SVG QA LOOP ─ PNG conv → 4 parallel QA → fix → re-verify          │
│        │                                                                     │
│        ▼                                                                     │
│   Phase 7: HTML FRAGMENTS ─ 4 parallel agents fill tab-*.html                │
│        │                                                                     │
│        ▼                                                                     │
│   Phase 8: BROWSER QA ─ Playwright screenshots + multimodal analysis         │
│        │                                                                     │
│        ▼                                                                     │
│   Phase 9: DEPLOY ─ make deploy → Cloudflare Pages                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Phases

### Phase 1: Discovery & Gap Analysis

**Time:** 30-60 min (mostly agent work)

**Goal:** Identify all gaps in existing content. Confirm chapter list.

**Tasks:**

1. Read all existing markdown sources
2. Spawn `general-purpose` agent: "Audit these N files. What concepts are referenced but never explained? What sections are missing for the target audience '<persona>'?"
3. Present gaps as DP-A/B/C: which to fill, which to skip, which to defer to "hors-scope" tab.
4. If gaps to fill: spawn parallel content agents (1 per chapter).

**Output:** Complete set of `XX-chapter.md` files at `~/.roxabi/forge/<project>/`.

**Decision gate:** Operator validates chapter list. Skip content too late = costly to backfill.

---

### Phase 2: Wireframe (CRITICAL AUDIT)

**Time:** 45-90 min

**Goal:** Per-tab structural specification including diagram types, CSS class usage, content density estimates.

**Tasks:**

1. Operator (or 1 doc-writer agent) drafts `_wireframe.md` covering:
   - Per-tab CSS class plan (`.cards`, `.callout`, `.card.info/warning/critical/accent`, `<details class="disclosure">`, `.table-wrap`, `.kv-strip`, `.stat-grid`)
   - Per-tab fgraph diagrams with **type AND content**
   - Anti-patterns to avoid (decorative sub-headers, palette legends, fake actor swimlanes, redundant optional markers)
   - Semantic color usage (cyan = user/cmd, magenta = orchestrator, green = auto/validation, amber = optional, red = critical)
2. **CRITICAL AUDIT** — spawn 1 agent to review the wireframe BEFORE mass-prod:
   - Verify each fgraph type matches the content semantically
     - `sequence` = multi-actor interactions over time ONLY
     - `state` = workflow phases / lifecycle
     - `dep-graph` = linear pipeline with dependencies
     - `hub-and-spoke` = orchestrator + radial children
     - `decision tree` = branching questions → outcomes
     - `architecture` = static layered/stacked components
     - `gantt` = time-based tasks
3. Fix wireframe based on audit findings.

**Output:** `_wireframe.md` v3+ at the guide root.

**Decision gate:** Operator validates wireframe. **DO NOT SKIP THIS AUDIT.** A bad wireframe = N bad agents downstream.

**Pitfall learned:** Initial mapping put `sequence` on everything pipeline-shaped (e.g., `/dev` cycle). First SVG produced was "catastrophique" (4 fake actors invented). Fix took an audit + corrected mapping for 5+ diagrams.

---

### Phase 3: Forge HTML Shell

**Time:** 5-10 min

**Goal:** Generate the multi-tab HTML scaffold.

**Tasks:**

1. Invoke `/forge:forge-guide` skill with:
   - Project name
   - Design tokens (use Roxabi defaults unless overriding)
   - Tab list (chapter names + IDs)
2. Verify output:
   - `idea-to-prod.html` (or similar — shell with topnav + panels)
   - `css/<project>.css` (Roxabi tokens + component classes)
   - `js/<project>.js` (theme toggle + tab loader)
   - `tabs/<project>/tab-*.html` placeholders

**Critical CSS adjustments to validate upfront:**

- `.panel { max-width: NNNN px; }` — 1280px works well for content density; 960px is too narrow.
- `.tabs { flex-wrap: wrap; }` — NOT `overflow-x: auto` (tabs get cut off invisibly).
- `figure.card img { width: 100%; max-width: 920px; display: block; margin: 0 auto; }` — diagrams must scale UP, not just down.
- `figcaption.card-label { font-size: 0.8125rem; text-align: center; }` — readable caption.

**Output:** Working shell at `~/.roxabi/forge/<project>/`.

---

### Phase 4: Benchmark Diagram (CRITICAL)

**Time:** 30-45 min including iteration

**Goal:** Produce ONE reference SVG. Validate visually. Use as the quality target for all subsequent SVGs.

**Why:** Downstream parallel agents will IMITATE the reference. If the reference has an anti-pattern (palette legend, fake actors, decorative sub-headers), all 28 children inherit it.

**Tasks:**

1. Choose a representative diagram (typically the "main" one — a state machine of the core workflow works well).
2. Spawn 1 agent to produce it as self-contained SVG.
3. Convert to PNG (see Phase 6 conversion).
4. Inspect visually (just look at it yourself).
5. Apply fixes:
   - Remove decorative sub-headers / banners
   - Remove palette legends with dots
   - Remove fake actor swimlanes (if it's 1-actor flow)
   - Verify semantic colors
6. Iterate until 🟢.

**Output:** `tabs/<project>/diagrams/<benchmark>.svg` — the gold standard.

**Pitfall learned:** Our `cycle-dev-state.svg` benchmark had a palette legend (anti-pattern). All 28 downstream SVGs copied it. Required a cleanup sweep.

---

### Phase 5: Mass-Prod SVG (parallel)

**Time:** 5-10 min wall-clock (agents run in parallel)

**Goal:** Generate all remaining N SVGs as self-contained files.

**Strategy:** **Specialize agents by visual cluster** for stylistic consistency.

**Typical cluster split (adjust for your guide):**

| Cluster | fgraph types | Approx count | Difficulty |
|---|---|---|---|
| Agent SEQ | sequence (true multi-actor) | 2-5 | Medium |
| Agent STATE | state machines | 4-7 | Medium |
| Agent DEP | dep-graph (linear pipelines) | 5-8 | Easy |
| Agent HUB-DEC | hub-and-spoke + decision tree | 4-7 | Medium |
| Agent ARCH-GANTT | architecture + gantt + pie | 2-5 | Medium |

**Prompt template per agent** (compact, ~800 tokens):

```
Task: Generate N {cluster-type} diagrams as self-contained SVG files.

CONTEXT (read first):
- Style guide: _wireframe.md §3 (anti-patterns + color semantics)
- Reference SVG: tabs/<project>/diagrams/<benchmark>.svg (visual benchmark)
- Output dir: tabs/<project>/diagrams/

SHARED STYLE:
- Dark bg #0a0e1a, text #e5e7eb
- Self-contained (inline styles, sans-serif)
- {type-specific layout guidance: vertical / horizontal / radial / etc.}

ROXABI SEMANTIC COLORS:
- cyan #00d4ff = user/cmd/sender
- magenta #ff00aa = app/Claude/orchestrator
- green #34d399 = DB/data/auto/validation
- amber #fbbf24 = optional/warning
- red #f87171 = critical/error
- muted #94a3b8 = neutral/passive (USE SPARINGLY)

ANTI-PATTERNS — never add/keep:
- ❌ Decorative sub-headers ("INIT / PHASE 1 / ÉTAPE 1")
- ❌ Palette legends with dots
- ❌ Fake actor swimlanes (NOT applicable to true sequences)
- ❌ Redundant optional markers (dashed + amber + text "(opt)" together)

DIAGRAMS TO PRODUCE (N):
1. <file>.svg — Source: <chapter.md> §X.Y — {content brief}
2. ...

OUTPUT FORMAT per SVG: width 600-900px, height as needed, self-contained.
```

**Output:** N SVG files at `tabs/<project>/diagrams/`.

---

### Phase 6: SVG QA Loop (parallel)

**Time:** 15-30 min total (1-2 cycles)

**Goal:** Eliminate visual bugs. Catch anti-patterns. Verify color semantics.

**Cycle structure:**

```
[Generate/Fix] → [Convert SVG→PNG] → [4 parallel QA agents] → [Aggregate] → [Decide: fix vs ship]
```

**Conversion command:**

```bash
# Via Flatpak (recommended — rsvg-convert v2.61+)
RSVG_PATH=org.gnome.Platform/49
for svg in *.svg; do
  flatpak --user run --branch=49 --filesystem="$PWD" \
    --command=rsvg-convert $RSVG_PATH \
    -z 2 -f png -o "_previews/${svg%.svg}.png" "$svg"
done
```

**QA agent prompt template:**

```
Task: Visual QA of N PNG diagrams. Read each and identify problems.

INPUT PNGs: [list]
REFERENCE (calibrate against): tabs/<project>/diagrams/_previews/<benchmark>.png

CHECK FOR:
- Visual issues: truncated text, overlaps, off-canvas, poor alignment
- Style violations: decorative sub-headers, palette legends, fake actors,
  redundant optional markers, color semantic drift
- Functional: each element carries info (no decorative chrome)

OUTPUT (table):
| # | File | Verdict | Issues |
|---|------|---------|--------|

End with:
- TOTAL: X 🟢 / Y 🟡 / Z 🔴
- TOP 3 issues by severity
- Systemic problems
```

**Fix strategy:**

- **🔴** = regenerate from scratch (Write)
- **🟡** = targeted Edit
- **🟢** = no-op

**CRITICAL learnings:**

1. **PNG QA can produce false positives on color nuances** (green/amber similar in dark mode). For semantic color disputes, **trust SVG source inspection** (read the file directly + verify color attribute), not PNG visual inspection.
2. **Verify the benchmark is clean BEFORE downstream agents start imitating it.** Cleanup the reference first.
3. **Track "claimed fixed" vs "actually applied"** — fix agents sometimes report inline. Spot-check.

**Decision gate:** Operator chooses fix scope:
- (A) Min vital — 🔴 only
- (B) Recommended — 🔴 + systemic 🟡
- (C) Sweep complete — all 🟡

Usually (C) if affordable (5-10 min more agent work).

---

### Phase 7: HTML Fragments (parallel)

**Time:** 10-20 min wall-clock (4 agents parallel)

**Goal:** Fill all 16 (or N) tab-*.html files with structured content + SVG references.

**Strategy:** Split by content density.

| Agent | Chapters | Density |
|---|---|---|
| A | Light (e.g., sommaire + intro + simple chapters) | Low |
| B | Medium (4-6 standard chapters) | Medium |
| C | Dense (3 long chapters with lots of code/cards) | High |
| D | Mix (remaining + FAQ + special-format tabs) | High |

**Prompt template per agent:**

```
Task: Fill N HTML tab fragments with structured content from MD sources.

DIR: ~/.roxabi/forge/<project>/
SPEC (read first): _wireframe.md §4 (per-tab spec)

TABS TO FILL:
| Target | Source MD | SVGs to reference |
|---|---|---|
| tabs/<project>/tab-X.html | XX-chapter.md | <slug1>.svg, <slug2>.svg |
| ...

CSS CLASSES (use existing, don't reinvent):
- .summary-card .summary-title .summary-body
- .kv-strip { .kv with <b>label</b> }
- .section-title (wrap each ## X.Y heading)
- .cards grid with .card.{info|warning|critical|accent}
- .callout, .table-wrap, <details class="disclosure">
- .verdict-badge.{green|amber|red|cyan|magenta}
- .marker-badge.{easy|medium|hard} for 🟢🟡🔴
- .stat-grid > .stat > .stat__value + .stat__label

MARKER MAPPING:
- 🟢 → <span class="marker-badge easy">🟢 Débutant</span>
- 🟡 → <span class="marker-badge medium">🟡 Intermédiaire</span>
- 🔴 → <span class="marker-badge hard">🔴 Avancé</span>

SVG INTEGRATION (use EXACTLY this pattern):
<figure class="card">
  <img src="tabs/<project>/diagrams/<slug>.svg"
       alt="..." style="width:100%; height:auto;">
  <figcaption class="card-label">DIAGRAMME — ...</figcaption>
</figure>

⚠ CRITICAL — SVG path: src MUST be from document root
("tabs/<project>/diagrams/X.svg") NOT relative to fragment
("diagrams/X.svg") — fragments are loaded into the shell, so
browsers resolve paths against the shell's URL.

CONVENTION:
1. PRESERVE top comments
2. KEEP existing .summary-card + .kv-strip
3. REMOVE <div class="todo-placeholder">
4. Render every ## X.Y as .section-title + marker badge
5. Wrap long code blocks in <details class="disclosure">

ANTI-PATTERNS:
- ❌ Inline styles except figure alignment
- ❌ TODO placeholders remaining
- ❌ Reinventing CSS classes
```

**Output:** N filled tab fragments.

---

### Phase 8: Browser QA (Playwright)

**Time:** 10-15 min

**Goal:** Catch layout, path, and UX issues that static analysis misses.

**Tasks:**

1. Start local server: `cd ~/.roxabi/forge/<project> && python3 -m http.server 8080 &`
2. Verify HTTP 200 on `/idea-to-prod.html`
3. Run Playwright screenshot capture for ALL tabs:

```python
from playwright.sync_api import sync_playwright

tabs = ['sommaire', 'avant', 'demarrer', ...]  # all tab IDs
out_dir = '_qa-screenshots'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx.new_page()
    page.goto('http://localhost:8080/idea-to-prod.html')
    page.wait_for_selector('.tab-btn[data-tab="sommaire"]', state='visible')
    page.screenshot(path=f'{out_dir}/00-initial-viewport.png', full_page=False)
    for i, t in enumerate(tabs, start=1):
        page.click(f'.tab-btn[data-tab="{t}"]')
        page.wait_for_selector(f'.panel[data-panel="{t}"].active', state='visible')
        page.wait_for_timeout(800)  # SVG render time
        page.screenshot(path=f'{out_dir}/{i:02d}-{t}.png', full_page=True)
        # Check broken images per tab
        broken = page.evaluate(
            "Array.from(document.querySelectorAll('img'))"
            ".filter(img => !img.complete || img.naturalWidth === 0)"
            ".map(img => img.src)"
        )
        if broken: print(f'BROKEN in {t}:', broken)
    browser.close()
```

Run: `uv run --with playwright python3 capture-tabs.py`

4. Spawn 4 parallel QA agents (subagent_type general-purpose), each looking at 4 tabs:

```
Task: Visual QA of N PNG screenshots. Identify issues to fix before re-deploy.

INPUT PNGs: [list]

CHECK:
- Layout: overflow, alignment, awkward whitespace
- Typography/colors: contrast, marker visibility, code readability
- SVG diagrams: loaded? sized appropriately? aligned center?
- Tab navigation: all tabs visible? active state clear?
- Anything broken/unpolished for non-technical readers

OUTPUT: table + TOP 3 issues + systemic patterns
```

5. Aggregate findings. Fix top issues. Re-screenshot key tabs to verify.

**Critical UX checks (all caught us off-guard once):**

- **Tab overflow** — at 1440px viewport with 16 tabs, do they all fit on one row? If not, `flex-wrap: wrap` is mandatory.
- **SVG width** — do diagrams fill the panel reasonably? If `<img>` has inline `max-width: 100%` only (no `width: 100%`), small SVGs won't scale UP.
- **Broken image paths** — check `naturalWidth === 0` per `<img>`.

---

### Phase 9: Deploy

**Time:** 2-3 min

**Goal:** Push to Cloudflare Pages.

**Pre-flight:**

- `idea-to-prod.html` has `<meta name="diagram:color" content="<COLOR>">` — use one of `VALID_COLORS` = `{amber, blue, green, purple, orange, cyan, red, gold}`. **Hex values fall back to orange** with a build warning.
- All SVG paths use `tabs/<project>/diagrams/` prefix.
- All `<div class="todo-placeholder">` removed.

**Command:**

```bash
cd ~/.roxabi/forge && make deploy
```

This runs:
1. `gen-manifest.py` — regenerate forge index
2. `gen-deps.py` (if applicable)
3. `gen-image-manifests.py`
4. `gen-og-tags.py` — inject OG meta tags
5. `rsync` to `_dist/`
6. `npx wrangler pages deploy _dist --project-name=forge --branch=main`

**Output:** Deploy URL (`https://XXXXXXXX.forge-c73.pages.dev/<project>/<main>.html`) + canonical alias (`https://forge.roxabi.dev/<project>/<main>.html`).

---

## 5. Anti-Patterns (Hall of Shame)

Mistakes made in the source session — avoid in replay:

### Wireframe-level

- ❌ **Using `sequence` for everything pipeline-shaped** — sequence = multi-actor interactions only. For 1-actor flows: use `state` or `dep-graph`.
- ❌ **Letting agents invent actors** to fill a sequence diagram. If only one entity acts, it's not a sequence.
- ❌ **Defining anti-patterns in the wireframe but having the reference SVG violate them.** Reference must be clean.

### SVG-level

- ❌ **Decorative all-caps sub-headers** ("ZERO TO FIRST COMMAND", "ÉTAPE 1 — LIRE") — pure chrome, no info.
- ❌ **Palette legends with dots at the bottom** ("● cyan · ● magenta · ● green") — color should be self-explanatory.
- ❌ **Triple-redundant optional markers** (dashed border + amber color + text label "(opt)") — pick ONE.
- ❌ **Cyclic loops on a single state** when it's not semantically a real cycle.
- ❌ **Mis-applied gris muted** — gris = passive infra ONLY, not active steps.

### HTML/CSS-level

- ❌ **`.tabs { overflow-x: auto }`** — hides tabs without affordance. Use `flex-wrap: wrap`.
- ❌ **Inline `style="max-width:100%"` on diagram `<img>`** — image won't scale UP. Use `style="width:100%"` + CSS `max-width: 920px`.
- ❌ **`<img src="diagrams/X.svg">`** in tab fragments — wrong path because fragments are loaded into shell. Use full path from shell root.
- ❌ **Hex color in `<meta name="diagram:color">`** — forge palette is finite. Use named color (`cyan`, `green`, etc.).
- ❌ **Panel `max-width: 960px`** — too narrow for modern viewports. `1280px` is the sweet spot.

### Process-level

- ❌ **Trust agent self-reports for "fix applied"** without spot-check. Some fixes weren't applied.
- ❌ **Trust PNG visual QA for color semantics in dark mode.** Green/amber blur together. Trust SVG source inspection.
- ❌ **Skip browser test before deploy.** Static checks miss tab overflow, broken paths, etc.
- ❌ **Skip the benchmark cleanup.** All downstream agents imitate the reference — clean it first.

---

## 6. Decision Gates (DP-A/B/C Pattern)

At each phase end, present operator with functional decisions:

| Phase | Typical DP |
|---|---|
| 1 — Discovery | (A) Fill all gaps · (B) Defer some to hors-scope · (C) Cherry-pick |
| 2 — Wireframe | (A) Accept audit corrections · (B) Edit manually · (C) Re-audit specific clusters |
| 4 — Benchmark | (A) Accept · (B) Iterate style · (C) Change diagram type entirely |
| 6 — SVG QA | (A) Fix 🔴 only · (B) Fix 🔴+systemic 🟡 · (C) Full sweep |
| 8 — Browser QA | (A) Ship despite minor 🟡 · (B) Fix top 3 then ship · (C) Full polish pass |

**Functional framing rule:** use intention/effect terms ("widen panel", "fix tab visibility", "stop showing diagram"), NOT file paths or CSS symbol names. The operator is in decider mode, not implementer mode.


---

## 7. Time Budget (typical session)

| Phase | Wall-clock | Agent-time | Operator attention |
|---|---|---|---|
| 1 Discovery | 30-60 min | 20 min | 15 min |
| 2 Wireframe | 45-90 min | 30 min | 30 min |
| 3 Shell | 5-10 min | 5 min | 5 min |
| 4 Benchmark | 30-45 min | 15 min | 20 min (visual review) |
| 5 Mass-prod SVG | 5-10 min | 5 min (5 agents parallel) | 5 min |
| 6 SVG QA loop | 15-30 min | 10 min/cycle × 2 | 20 min |
| 7 HTML fragments | 10-20 min | 10 min (4 agents parallel) | 10 min |
| 8 Browser QA | 10-15 min | 10 min | 10 min |
| 9 Deploy | 2-3 min | 3 min | 2 min |
| **TOTAL** | **~3 hours** | **~2 hours** | **~2 hours** |

Agent and operator time overlap — wall-clock is the binding constraint. With parallelism, ~3 hours for a polished 10-20 tab guide with 20-30 diagrams.

---

## 8. Output Structure

After completion:

```
~/.roxabi/forge/<project>/
├── XX-chapter-NN.md             # 10-20 source files
├── _wireframe.md                # v3 design spec
├── POST-MORTEM.md               # captured during/after session
├── idea-to-prod.html            # shell (or <project>.html)
├── css/<project>.css            # Roxabi tokens + components
├── js/<project>.js              # tab loader + theme toggle
├── tabs/<project>/
│   ├── tab-*.html               # filled fragments
│   └── diagrams/
│       ├── *.svg                # 5-30 SVG files
│       └── _previews/           # PNG previews for QA
└── _qa-screenshots/             # Playwright captures
```

Deployed at: `https://forge.roxabi.dev/<project>/<main>.html`

---

## 9. Tools & Commands Reference

### SVG → PNG conversion

```bash
flatpak --user run --branch=49 --filesystem="$PWD" \
  --command=rsvg-convert org.gnome.Platform \
  -z 2 -f png -o out.png in.svg
```

Alternative: `apt install librsvg2-bin` then `rsvg-convert -z 2 -o out.png in.svg` (if installed natively).

### Playwright capture

```bash
uv run --with playwright python3 capture-tabs.py
# Browsers install one-time: playwright install chromium
```

### Local server

```bash
cd ~/.roxabi/forge/<project> && python3 -m http.server 8080
```

### Deploy

```bash
cd ~/.roxabi/forge && make deploy
```

### Check broken images (in console / Playwright)

```js
Array.from(document.querySelectorAll('img'))
  .filter(img => !img.complete || img.naturalWidth === 0)
  .map(img => img.src)
```

---

## 10. Customization for Other Themes

The pipeline is theme-agnostic. To adapt:

1. **Different audience** — adjust language register (simpler / more technical) in phase 1 content generation.
2. **Different visual identity** — override Roxabi tokens in CSS (`--accent`, `--accent2`, semantic colors). Update agent prompts to use the new palette.
3. **Different diagram density** — guides with mostly text need fewer SVGs; guides on visual topics (architecture, data flow) need more.
4. **Different tab count** — pipeline scales 5-20 tabs without changes. Beyond 20, consider grouping into mega-tabs.
5. **Different deploy target** — replace `make deploy` with your platform (GitHub Pages, Vercel, S3+CloudFront). Make sure the path convention matches.

---

## 11. References

- Source post-mortem: `~/.roxabi/forge/guide-idea-to-prod/POST-MORTEM.md`
- Related playbook: `multi-agent-audit-playbook.md` (similar parallel pattern, different goal)
- Forge skills: `plugins/forge/skills/forge-guide`, `plugins/forge/skills/forge-chart`
