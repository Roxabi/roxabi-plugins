# Brand Tokens & Dark Mode Rules

This file covers two token systems. Choose based on the output type:

| Output type | Token system | Font pair | Used by |
|-------------|-------------|-----------|---------|
| Split-file docs, charts, epics | **Baseline** (below) | IBM Plex Sans + IBM Plex Mono | forge-guide, forge-epic, forge-chart |
| Gallery templates | **Gallery extended** (see `gallery-base.css`) | Plus Jakarta Sans + JetBrains Mono | forge-gallery |

The gallery system extends the baseline with extra surface tiers (`--surface2`, `--card`), a dimmer text tier (`--text-xdim`), and a semantic color palette (`--green`, `--blue`, `--purple`, `--orange`, `--cyan`, `--amber`, `--red` each with `*-dim` variants). Gallery tokens are defined in `gallery-base.css` — do not duplicate them here.

---

## Baseline Tokens (Split-File / Chart / Epic)

## Which Theme to Use

1. Check `~/.roxabi/forge/<project>/brand/BRAND-BOOK.md` or `~/projects/<project>/brand/BRAND-BOOK.md`
2. Brand book found → derive tokens from its palette
3. No brand book, project is `lyra` / `voicecli` → **Lyra theme** (Forge Orange)
4. No brand book, project is `roxabi*` / `2ndBrain` → **Roxabi theme** (Gold)
5. Unknown project → **Lyra theme** (default)

---

## Lyra Theme — Forge Orange

```css
:root, [data-theme="dark"] {
  --bg:         #0a0a0f;
  --surface:    #18181f;
  --border:     #2a2a35;
  --text:       #fafafa;
  --text-muted: #9ca3af;
  --text-dim:   #6b7280;
  --accent:     #e85d04;
  --accent-dim: #7c2d0e;
}
[data-theme="light"] {
  --bg:         #fafaf9;
  --surface:    #f4f4f0;
  --border:     #d1ccc7;
  --text:       #1c1917;
  --text-muted: #57534e;
  --text-dim:   #78716c;
  --accent:     #c2410c;
  --accent-dim: #fef2e8;
}
```

## Roxabi Theme — Gold

```css
:root, [data-theme="dark"] {
  --bg:         #111210;
  --surface:    #1a1b18;
  --border:     #2e3028;
  --text:       #f0ede6;
  --text-muted: #9ca3af;
  --text-dim:   #7a7468;
  --accent:     #f0b429;
  --accent-dim: #78460d;
}
[data-theme="light"] {
  --bg:         #f8f7f4;
  --surface:    #f0ede8;
  --border:     #d6cfc8;
  --text:       #1c1917;
  --text-muted: #57534e;
  --text-dim:   #78716c;
  --accent:     #d97706;
  --accent-dim: #fef3c7;
}
```

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

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
```

```css
body        { font-family: 'IBM Plex Sans', system-ui, sans-serif; }
code, pre   { font-family: 'IBM Plex Mono', monospace; }
```

Other acceptable pairs: DM Sans + Fira Code, Plus Jakarta Sans + Azeret Mono.  
**Forbidden as primary fonts:** Inter, Roboto, Arial, bare `system-ui`.
