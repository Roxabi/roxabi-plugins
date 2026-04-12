# Diagram Meta Convention

Every HTML diagram includes these meta tags inside `<head>` for manifest indexing:

```html
<!-- diagram-meta:start -->
<meta name="diagram:title"     content="Title here">
<meta name="diagram:date"      content="2026-04-02">
<meta name="diagram:category"  content="guide">
<meta name="diagram:cat-label" content="Guide">
<meta name="diagram:color"     content="amber">
<meta name="diagram:badges"    content="latest">
<!-- diagram-meta:end -->
```

`serve.py` and `gen-manifest.py` parse everything between the two markers.

---

## Fields

| Field | Required | Notes |
|-------|----------|-------|
| `title` | yes | Human-readable; should match `<title>` tag |
| `date` | yes | Today's date, `YYYY-MM-DD` |
| `category` | yes | See table below |
| `cat-label` | yes | Display label (sentence case) |
| `color` | yes | See color table below |
| `badges` | no | `latest` for newest version; `draft`, `archived` also valid |
| `issue` | no | GitHub issue number, e.g. `445` (no `#`) |

---

## Categories

| `category` | `cat-label` | Used for |
|------------|-------------|----------|
| `guide` | Guide | User guides, how-tos, tutorials |
| `architecture` | Architecture | System architecture, component overviews |
| `analysis` | Analysis | Gap analysis, comparisons, research docs |
| `spec` | Spec | Feature specs, technical specifications |
| `plan` | Plan | Implementation plans, roadmaps |
| `frame` | Frame | Problem frames, context documents |
| `recap` | Recap | Project recaps, status updates |
| `review` | Review | Code reviews, diff analyses |
| `brand` | Brand | Brand assets, logo explorations |
| `gallery` | Gallery | Image / audio comparison galleries |

---

## Colors

| `color` | When to use |
|---------|-------------|
| `amber` | Lyra project, Forge Orange accent |
| `gold` | Roxabi project, Gold accent |
| `purple` | Complex analysis, multi-system docs |
| `blue` | Architecture, technical deep dives |
| `green` | Success paths, status dashboards |
| `cyan` | Data flows, streaming, real-time |
| `orange` | Migration guides, gap docs, warnings |
| `red` | Critical issues, breaking changes |

---

## Example with all optional fields

```html
<!-- diagram-meta:start -->
<meta name="diagram:title"     content="Lyra #447 — Event Bus Implementation Plan">
<meta name="diagram:date"      content="2026-04-02">
<meta name="diagram:category"  content="plan">
<meta name="diagram:cat-label" content="Plan">
<meta name="diagram:color"     content="amber">
<meta name="diagram:badges"    content="latest">
<meta name="diagram:issue"     content="447">
<!-- diagram-meta:end -->
```

---

## Manifest Output

The manifest entry generated from the above:

```json
{
  "f": "lyra/visuals/lyra-447-event-bus.html",
  "t": "Lyra #447 — Event Bus Implementation Plan",
  "d": "2026-04-02",
  "kb": 18,
  "cat": "plan",
  "cl": "Plan",
  "c": "amber",
  "b": ["latest"],
  "issue": "447"
}
```

After adding/editing diagrams, re-index:

```bash
cd ~/projects && make forge deploy
```
