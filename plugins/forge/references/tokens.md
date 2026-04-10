# Brand Tokens & Dark Mode Rules

This file covers two token systems. Choose based on the output type:

| Output type | Token system | Font pair | Used by |
|-------------|-------------|-----------|---------|
| Split-file docs, charts, epics | **Baseline** (below) | IBM Plex Sans + IBM Plex Mono | forge-guide, forge-epic, forge-chart |
| Gallery templates | **Gallery extended** (see `gallery-base.css`) | Plus Jakarta Sans + JetBrains Mono | forge-gallery |

The gallery system extends the baseline with extra surface tiers (`--surface2`, `--card`), a dimmer text tier (`--text-xdim`), and a semantic color palette (`--green`, `--blue`, `--purple`, `--orange`, `--cyan`, `--amber`, `--red` each with `*-dim` variants). Gallery tokens are defined in `gallery-base.css` — do not duplicate them here.

---

## Baseline Tokens (Split-File / Chart / Epic)

### Which Theme to Use

1. Check `~/.roxabi/forge/<project>/brand/BRAND-BOOK.md` or `~/projects/<project>/brand/BRAND-BOOK.md`
2. Brand book found → derive tokens from its palette
3. No brand book, project is `lyra` / `voicecli` → **Lyra theme** (Forge Orange)
4. No brand book, project is `roxabi*` / `2ndBrain` → **Roxabi theme** (Gold)
5. Unknown project → **Lyra theme** (default)

---

## Theme CSS Files

Full token definitions live in dedicated aesthetic files:

| Project | Aesthetic file | Accent |
|---------|---------------|--------|
| lyra, voicecli | `aesthetics/lyra.css` | Forge Orange `#e85d04` |
| roxabi*, 2ndBrain | `aesthetics/roxabi.css` | Gold `#f0b429` |
| default (unknown) | `aesthetics/editorial.css` | Slate `#64748b` |

**Usage in skills:** Copy brand token blocks (`--bg`, `--surface`, `--border`, `--text*`, `--accent*`) from the aesthetic file. Semantic colors (`--success*`, `--warning*`, `--error*`, `--info*`) come from `base/components.css`. Typography comes from `base/typography.css`.

---

## Three-Tier Dark Mode Hierarchy

| Token | Value | Contrast on `#0a0a0f` | Used for |
|-------|-------|----------------------|----------|
| `--text` | `#fafafa` | ~18:1 | Headings, nav labels, primary UI |
| `--text-muted` | `#9ca3af` | ~8:1 ✓ AA | Body paragraphs, descriptions, card content |
| `--text-dim` | `#6b7280` | ~4.3:1 | Timestamps, file paths, column headers, metadata |

**Rule:** Any element where the user reads more than one sentence → `--text-muted` (`#9ca3af`) or brighter. **Never `--text-dim` for body text.**

## Forbidden Colors for Body Text in Dark Mode

- `#1c1917` — light-mode text (near-black), invisible on dark bg
- `#374151`, `#2a2a35`, `#18181f` — surface/border colors, not text
- `#57534e` — light-mode secondary, too dark on dark backgrounds
- `#6b7280` — only for metadata/labels (4.3:1), **never for body paragraphs**

Common trap: setting `--text-muted` and `--text-dim` to the same value (`#6b7280`) makes all body text fail AA. Always differentiate them.

---

## Typography (Default)

Use IBM Plex Sans + IBM Plex Mono (loaded via Google Fonts in the shell templates).

Typography rules are defined in `base/typography.css` — skills should read and inline that file.

Other acceptable pairs: DM Sans + Fira Code, Plus Jakarta Sans + Azeret Mono.
**Forbidden as primary fonts:** Inter, Roboto, Arial, bare `system-ui`.
