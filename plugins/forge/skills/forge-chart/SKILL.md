---
name: forge-chart
description: 'Create a quick self-contained single-file HTML visual — Mermaid flowchart, dependency tree, sequence diagram, or CSS layout. No server needed, works with file://. Triggers: "draw" | "diagram" | "visualize" | "sketch" | "map" | "show the flow" | "quick visual".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob, Grep, ToolSearch
---

# Chart — Single-File Quick Visual

Create a self-contained HTML file. All CSS/JS inline — no fetch, no external files, works with `file://`.
Use for: Mermaid flowcharts, dependency trees, sequence diagrams, simple CSS layouts.

Output: `~/.roxabi/forge/<project>/visuals/{slug}.html` or `~/.roxabi/forge/_shared/diagrams/{slug}.html`.

**Read before generating:**

```
${CLAUDE_PLUGIN_ROOT}/references/tokens.md        — CSS tokens + dark mode rules
${CLAUDE_PLUGIN_ROOT}/references/diagram-meta.md  — meta tag format + categories
```

Mermaid note: single-file has **no dynamic-tab pitfalls** — use standard `startOnLoad: true`. No need for `mermaid.render()`, no `rgba()` restriction.

Let:
  ARGS := $ARGUMENTS

---

## Phase 1 — Context

1. Detect project from ARGS or cwd.
2. Issue number in ARGS (`#N` or `NNN-`) → filename `{N}-{slug}.html`, set `diagram:issue` meta.
3. Cross-project / no project → `~/.roxabi/forge/_shared/diagrams/`.
4. Brand book check (same as other skills).

---

## Phase 2 — Visual Type

| Content | Mermaid type |
|---------|-------------|
| Task / issue dependency graph | `flowchart TD` or `LR` |
| Data flow between services | `flowchart LR` |
| API / message sequence | `sequenceDiagram` |
| State machine | `stateDiagram-v2` |
| Architecture layers | CSS Grid cards (no Mermaid) |
| Simple timeline | CSS flex with connectors |

Max 12 nodes per diagram. Split into multiple diagrams if more complex.

Choose `diagram:category` + `diagram:color` from `references/diagram-meta.md`.

---

## Phase 3 — Generate

Single HTML file. Everything inline.

```html
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{TITLE}</title>
  <!-- diagram-meta:start -->
  <meta name="diagram:title"     content="{TITLE}">
  <meta name="diagram:date"      content="{YYYY-MM-DD}">
  <meta name="diagram:category"  content="{category}">
  <meta name="diagram:cat-label" content="{Label}">
  <meta name="diagram:color"     content="{color}">
  <meta name="diagram:badges"    content="latest">
  <!-- optional: <meta name="diagram:issue" content="{N}"> -->
  <!-- diagram-meta:end -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
  <style>
    :root, [data-theme="dark"] {
      --bg: #0a0a0f; --surface: #18181f; --border: #2a2a35;
      --text: #fafafa; --text-muted: #9ca3af; --text-dim: #6b7280;
      --accent: #e85d04;
    }
    [data-theme="light"] {
      --bg: #fafaf9; --surface: #f4f4f0; --border: #d1ccc7;
      --text: #1c1917; --text-muted: #57534e; --text-dim: #78716c;
      --accent: #c2410c;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body {
      background: var(--bg); color: var(--text);
      font-family: 'IBM Plex Sans', system-ui, sans-serif;
      padding: 2rem 1.5rem; line-height: 1.6;
    }
    header {
      display: flex; align-items: baseline; gap: 1rem;
      margin-bottom: 2rem; flex-wrap: wrap;
    }
    header h1 { font-size: 1.25rem; font-weight: 600; flex: 1; }
    .issue-tag {
      font-family: 'IBM Plex Mono', monospace; font-size: 0.8125rem;
      color: var(--accent); font-weight: 600;
    }
    .theme-btn {
      padding: 0.2rem 0.5rem; font-size: 0.75rem;
      color: var(--text-dim); background: transparent;
      border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
    }
    .mermaid-wrap {
      display: flex; justify-content: center; align-items: flex-start;
      overflow: auto; padding: 1.5rem; margin-bottom: 1.5rem;
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    }
    .mermaid svg { max-width: none; }
    p { color: var(--text-muted); margin-bottom: 0.75rem; }
  </style>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
    mermaid.initialize({
      startOnLoad: true, theme: 'base',
      themeVariables: {
        primaryColor: '#18181f', primaryTextColor: '#fafafa',
        primaryBorderColor: '#e85d04', lineColor: '#6b7280',
        secondaryColor: '#2a2a35', background: '#0a0a0f',
        edgeLabelBackground: '#18181f', nodeTextColor: '#9ca3af',
      },
      flowchart: { useMaxWidth: false, curve: 'basis' }
    })
  </script>
</head>
<body>
  <header>
    <!-- include .issue-tag span only if issue-linked -->
    <span class="issue-tag">#{ISSUE}</span>
    <h1>{TITLE}</h1>
    <button class="theme-btn" id="theme-toggle">◑ light</button>
  </header>

  <div class="mermaid-wrap">
    <div class="mermaid">
flowchart TD
    A["Node A"] --> B["Node B"]
    </div>
  </div>

  <script>
    var K = 'chart-{SLUG}-theme'
    var s = localStorage.getItem(K) || 'dark'
    document.documentElement.setAttribute('data-theme', s)
    var b = document.getElementById('theme-toggle')
    b.textContent = s === 'dark' ? '◑ light' : '◑ dark'
    b.addEventListener('click', function () {
      var n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', n)
      localStorage.setItem(K, n)
      this.textContent = n === 'dark' ? '◑ light' : '◑ dark'
    })
  </script>
</body>
</html>
```

**Token overrides:** replace the token block with brand tokens if brand book found.

**Mermaid theme variables:** adjust `primaryBorderColor` to brand accent. Use hex colors only in `style` node directives.

**Dark mode text:** any descriptive `<p>` → `color: var(--text-muted)`. Metadata → `color: var(--text-dim)`.

---

## Phase 4 — Report

```
Created: {path}/{slug}.html

Open:    file://{path}/{slug}.html     (no server needed)
  or:    cd {path} && python3 -m http.server 8080

Deploy:  cd ~/projects/lyra-stack && make diagrams deploy
```

$ARGUMENTS
