# Shell Processing — Split-File Pipeline

Shared pipeline for all split-file skills (forge-guide, forge-epic). Each skill defines `{NAME}` and skill-specific placeholder values; the pipeline steps are identical.

## Steps

1. Read `shells/split.html` template
2. Concatenate base CSS files in order: `reset → layout → typography → components → explainer-base`
3. Read selected aesthetic CSS
4. Read `base/tab-loader.js`, substitute `{NAME}` with the skill-defined name value
5. Substitute placeholders:
   - `{NAME}` → skill-defined (for localStorage key scoping + tab-loader.js)
   - `{BASE_STYLES}` → concatenated base CSS
   - `{AESTHETIC_STYLES}` → selected aesthetic CSS
   - `{TITLE}` → skill-defined
   - `{DATE}`, `{CATEGORY}`, `{CAT_LABEL}`, `{COLOR}`, `{BADGES}` → diagram metadata
   - `{HEADER}` → styled header block (eyebrow, title, subtitle, verdict badges)
   - `{TABS}` → tab button elements (one per tab)
   - `{PANELS}` → panel container elements (one per tab)
   - `{MAIN_WRAP_START}` / `{MAIN_WRAP_END}` → content area wrapper (standard or with TOC sidebar)
   - `{TAB_LOADER_JS}` → tab-loader.js with `{NAME}` substituted
   - `{HEAD_EXTRAS}` → optional (e.g., svg-pan-zoom CDN for Mermaid)
   - `{EXTRA_STYLES}` → skill-specific CSS additions
   - `{EXTRA_SCRIPTS}` → optional (e.g., mermaid-init.js)
6. Output: split-file HTML (requires HTTP serve)

## Skill-Specific Overrides

| Placeholder | forge-guide | forge-epic |
|---|---|---|
| `{NAME}` | diagram slug | `{ISSUE}-{slug}` |
| `{TITLE}` | free-form title | `{PROJ} #{ISSUE} — {Short Title}` |
| `{EXTRA_STYLES}` | guide-specific CSS (if any) | epic-hero + status badge CSS |
