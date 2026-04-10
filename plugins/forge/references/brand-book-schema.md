# Brand Book Schema — `forge.yml`

Structured project-level configuration that forge skills read as a **decision substrate**. When a `forge.yml` exists for a project, the plugin treats it as the source of truth for brand-locked decisions (aesthetic, component defaults, deliver constraints) and only runs judgment phases for the decisions the brand book explicitly leaves open.

This schema is the long-term replacement for inferring project style from palette-only `BRAND-BOOK.md` tables. Legacy brand books still work as a fallback — new projects should prefer `forge.yml`.

---

## Purpose

Two user personas with opposite needs:

| Persona | Needs |
|---|---|
| **New user** (no brand established) | Full Design Phase judgment — teach them what good looks like |
| **Project with defined design** (lyra, roxabi) | Plugin should apply the brand, not re-propose it |

`forge.yml` is how a project declares its design so the plugin stops asking. When present:
- **Aesthetic is locked** — plugin skips Frame/aesthetic decision entirely.
- **Component defaults are pre-filled** — Style phase uses brand components unless content demands override.
- **Deliver checks brand constraints** — verifies output matches brand's `must_match` rules.

When absent: plugin runs in **exploration mode** with the full Design Phase.

---

## Discovery order

Skills check these paths in order; first match wins. The runtime mirror wins over the repo path —
the mirror is for local override and experimentation; the repo is the committed base.

```bash
# 1. Preferred — structured config
ls ~/.roxabi/forge/{PROJ}/brand/forge.yml 2>/dev/null     # runtime mirror (local override wins)
ls ~/projects/{PROJ}/brand/forge.yml 2>/dev/null          # repo, committed base

# 2. Legacy — palette-only BRAND-BOOK.md (parse color table)
ls ~/.roxabi/forge/{PROJ}/brand/BRAND-BOOK.md 2>/dev/null # runtime mirror
ls ~/projects/{PROJ}/brand/BRAND-BOOK.md 2>/dev/null      # repo, committed base
```

If `forge.yml` is found → use it as the full decision substrate.
If only legacy `BRAND-BOOK.md` is found → derive palette from its color table, default every other decision to plugin defaults.
If nothing is found → exploration mode.

---

## Full schema

```yaml
# forge.yml — Project brand book for forge skills
# All fields are optional. Missing fields fall through to plugin defaults.

schema_version: 1

# ── Aesthetic ──────────────────────────────────────────────────
# Which aesthetic CSS file to use. One of:
#   lyra.css | roxabi.css | blueprint.css | terminal.css | editorial.css | caveman.css
# Or: '@inherit-palette' to derive a custom aesthetic from palette tokens below.
aesthetic: lyra.css

# ── Palette (CSS custom properties) ─────────────────────────────
# Maps to :root and [data-theme="dark"] in the generated CSS.
# Omit entries to keep the aesthetic file's defaults.
palette:
  dark:
    bg:         '#0a0a0f'   # page background
    surface:    '#18181f'   # elevated panels / cards
    border:     '#2a2a35'
    text:       '#fafafa'
    text-muted: '#9ca3af'   # body copy in dark mode
    text-dim:   '#6b7280'   # metadata, labels
    accent:     '#e85d04'   # brand accent — one dominant element per composition
    accent-dim: '#7c2d0e'
  light:
    bg:         '#fafaf9'
    surface:    '#f4f4f0'
    border:     '#d1ccc7'
    text:       '#1c1917'
    text-muted: '#57534e'
    text-dim:   '#78716c'
    accent:     '#c2410c'
    accent-dim: '#fef2e8'

# ── Typography ──────────────────────────────────────────────────
# Font family overrides. Fall through to aesthetic defaults if omitted.
typography:
  display:  'Chakra Petch'    # hero headlines only (forge-chart/guide hero titles)
  sans:     'Outfit'          # section titles, wordmark, nav
  body:     'Inter'           # all prose, UI labels
  mono:     'JetBrains Mono'  # CLI commands, config values, file paths

# ── Component defaults ──────────────────────────────────────────
# Pre-fill Style phase decisions. Skill-specific content may override
# individual slots if 'allow_override' permits it.
components:
  hero:          left-border  # left-border | elevated | top-border | stat-grid
  section_label: dot          # dot | triangle | square
  card_default:  accent       # maps to .card.accent (border-left accent color)
  timeline:      steps        # .steps + .step + .step-num (base/explainer-base.css)
  badges:        verdict      # .verdict-badge.green/amber/cyan/red
  mermaid_theme_bias: dark    # dark | light — default theme for Mermaid rendering

# ── Structure preferences ───────────────────────────────────────
# Bias Structure decisions for this project. Does not override content
# topology (e.g. a dep graph is still a Mermaid flowchart), but resolves
# ties between equally valid choices.
structure_defaults:
  prefer_fgraph_under: 6       # hub-and-spoke with ≤ N peers → fgraph over mermaid
  prefer_mermaid_over: 8       # > N nodes → mermaid regardless of topology
  comparison_as_table: true    # matrices use HTML tables, not grid cards

# ── Canonical examples ──────────────────────────────────────────
# Reference outputs the plugin should match when generating new visuals.
# Deliver phase can spot-check generated output against these files.
examples:
  - ~/.roxabi/forge/lyra/visuals/tabs/nats-roadmap/tab-current.html
  - ~/.roxabi/forge/lyra/visuals/tabs/agent-arch/tab-overview.html

# ── Deliver constraints ─────────────────────────────────────────
# Verification rules the Deliver phase enforces for every generated output.
# Each rule is a human-readable constraint; skills interpret the strings
# against their output. Fail = report to user before writing the file.
deliver_must_match:
  - 'accent color is Forge Orange (#e85d04 dark / #c2410c light)'
  - 'hero uses .hero.left-border variant'
  - 'section labels use .section-label.dot prefix'
  - 'body copy color is var(--text-muted), not var(--text-dim)'
  - 'no emoji in section headers'
  - 'Mermaid diagrams wrapped in .diagram-shell with zoom controls'

# ── Override policy ─────────────────────────────────────────────
# Which decisions are locked by this brand book vs. open to content override.
#   locked    — plugin may never deviate from brand book value
#   partial   — plugin uses brand default but may override if content demands
#   open      — plugin decides per content (brand book value is advisory)
allow_override:
  aesthetic:  locked    # brand aesthetic always wins
  palette:    locked    # colors always from brand book
  typography: locked    # fonts always from brand book
  components: partial   # hero/label/card default from brand, may flex
  structure:  open      # content topology decides (brand book is tiebreak)
  examples:   advisory  # examples guide but don't constrain

# ── Project metadata (optional) ─────────────────────────────────
project:
  name: 'Lyra'
  full_name: 'Lyra by Roxabi'
  tagline: 'Your intelligence, compounded.'
  category: 'Personal Intelligence Engine'
```

---

## Field reference

### Top-level keys

| Key | Type | Required? | Default | Role |
|---|---|---|---|---|
| `schema_version` | int | no | `1` | Schema version for migration compatibility |
| `extends` | string | no | (none) | Path to a parent brand book to inherit from — see `§ Extends` below |
| `aesthetic` | string | no | plugin default (`editorial.css` or project-derived) | Which aesthetic CSS file to use |
| `palette` | object | no | aesthetic file defaults | CSS custom property overrides |
| `typography` | object | no | aesthetic file defaults | Font family overrides |
| `components` | object | no | plugin defaults per skill | Component selection defaults |
| `structure_defaults` | object | no | plugin defaults | Structure phase bias (tiebreakers) |
| `examples` | list | no | `[]` | Canonical visual references |
| `deliver_must_match` | list | no | `[]` | Verification constraints |
| `allow_override` | object | no | all `partial` | Lock-vs-flex policy per decision |
| `project` | object | no | `{}` | Optional project metadata (informational) |

### `components` values

| Field | Valid values |
|---|---|
| `hero` | `left-border`, `elevated`, `top-border`, `stat-grid` |
| `section_label` | `dot`, `triangle`, `square` |
| `card_default` | `default`, `accent`, `info`, `warning`, `critical` |
| `timeline` | `steps`, `phases`, `flex-connectors` |
| `badges` | `verdict`, `status`, `none` |
| `mermaid_theme_bias` | `dark`, `light`, `auto` |

### `allow_override` values

| Value | Meaning | Plugin behavior |
|---|---|---|
| `locked` | Brand book value always wins | Plugin never deviates |
| `partial` | Brand default, content may override | Plugin uses brand default; rewrites only if content strongly demands |
| `open` | Plugin decides per content | Brand book value is a hint, not a rule |
| `advisory` | Informational only | Plugin reads but does not enforce |

---

## Minimal example

For projects that only want to lock the aesthetic + palette:

```yaml
schema_version: 1
aesthetic: roxabi.css
palette:
  dark:
    accent: '#d4af37'
allow_override:
  aesthetic: locked
  palette:   locked
  components: open
  structure:  open
```

Everything else falls through to plugin defaults.

---

## Extends

The optional `extends:` key lets one brand book inherit from another. Use it when a project wants
to reuse an existing brand (aesthetic, palette, typography, components) but override a few fields —
without copy-pasting the entire file.

### Syntax

```yaml
extends: ~/projects/lyra/brand/forge.yml
```

Value is a single path string. Accepted forms: absolute, home-relative (`~/...`), or relative to
the current file's directory (`../lyra/brand/forge.yml`). Lists are not supported — one parent per
file.

### Merge rules

| Field | Rule |
|---|---|
| `schema_version` | Child wins; mismatch → warn |
| `project` | Child wins |
| `aesthetic` | Child wins |
| `palette.dark` / `palette.light` | Per-key merge — child keys override matching parent keys |
| `typography` | Per-key merge |
| `components` | Per-key merge |
| `structure_defaults` | Per-key merge |
| `allow_override` | Per-key merge |
| `examples` | Concatenation with dedup (parent first) |
| `deliver_must_match` | Concatenation with dedup (parent first) |

Full load-order semantics, cycle detection, chain depth cap (10 levels), and missing-parent
behavior are documented in `brand-book-loader.md § Extends`.

### Minimal example — voicecli inherits lyra

See `references/examples/forge.yml.extends-example` for a complete minimal example showing voicecli
inheriting lyra's brand and overriding only `project` metadata and two delivery rules.

---

## How each skill consumes `forge.yml`

| Skill | Fields it reads | What it does with them |
|---|---|---|
| `forge-chart` | `aesthetic`, `palette`, `components.hero`, `components.section_label`, `components.timeline`, `mermaid_theme_bias`, `structure_defaults`, `deliver_must_match` | Skips Frame phase. Uses brand aesthetic + palette verbatim. Pre-fills Style table with brand components. Deliver verifies against `must_match` rules. |
| `forge-guide` | `aesthetic`, `palette`, `typography`, `components`, `structure_defaults`, `examples`, `deliver_must_match` | Same as forge-chart + uses `examples` to spot-check generated tab fragments against canonical references. |
| `forge-gallery` | `aesthetic`, `palette`, `typography`, `deliver_must_match` | Gallery templates are content-driven (pivot/simple/comparison/audio/multi-mode), so `components` is ignored. Brand palette + deliver constraints apply. |
| `forge-epic` | `aesthetic`, `palette`, `components.hero`, `components.section_label`, `deliver_must_match` | Epic hero inherits brand components. Tab structure is content-driven (overview/breakdown/deps/criteria), not brand-influenced. |

---

## Integration with Aesthetic Detection precedence

When `forge.yml` is found, it supersedes the current priority chain in `forge-ops.md` § Aesthetic Detection. The updated precedence becomes:

| Priority | Signal | Effect |
|---|---|---|
| 1 | Explicit `--aesthetic` arg | Always wins |
| 2 | **`forge.yml` present** | **Full brand-locked mode — all brand book fields applied** |
| 3 | Legacy `BRAND-BOOK.md` palette table | Palette only; components/structure fall through to plugin defaults |
| 4 | Project name match (lyra/voicecli → lyra.css; roxabi*/2ndBrain → roxabi.css) | Aesthetic only; no component lock |
| 5 | Frame phase output (exploration mode) | Content-type fallback |
| 6 | Default (`editorial.css`) | Last resort |

---

## Migration path for existing projects

1. **Audit current state** — what aesthetic is the project already using? What components appear in its canonical outputs?
2. **Write `forge.yml`** — fill in the fields from what's already in use. Start minimal (aesthetic + palette) and extend as needed.
3. **Place it** — at `~/projects/{proj}/brand/forge.yml` (committed base, versioned in the project repo). Optionally also place a copy at `~/.roxabi/forge/{proj}/brand/forge.yml` (runtime mirror) if you want a machine-local override. The mirror wins over the repo when both are present — see `brand-book-loader.md § Discovery Rationale`.
4. **Verify** — run a forge skill and confirm it reports the brand book was loaded. Plugin should log: *"Brand book loaded from {path} — applying locked fields: aesthetic, palette, components.hero, components.section_label"*.
5. **Iterate** — when generated outputs drift from brand, tighten `allow_override` (e.g. flip `components: partial` → `locked`).

---

## See also

- `references/forge-ops.md` — current Aesthetic Detection precedence (pre-brand-book)
- `references/examples/forge.yml.example` — concrete example filled in for Lyra
- `references/aesthetics/` — available aesthetic CSS files
- `references/base/components.css` — component classes referenced in `components` field
- `references/base/explainer-base.css` — hero variants, section labels, cards, timeline
