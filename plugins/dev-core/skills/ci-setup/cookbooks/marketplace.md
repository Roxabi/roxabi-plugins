# Cookbook: Marketplace Plugins

Let:
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

## Phase 3 — Marketplace Plugins

dev-core already installed. Discover available plugins from our marketplace and curated external sources.

### 3a — Discover Roxabi plugins

1. Ensure marketplace is registered:
   ```bash
   claude plugin marketplace add Roxabi/roxabi-plugins 2>/dev/null || true
   ```

2. Fetch live plugin list from GitHub:
   ```bash
   gh api repos/Roxabi/roxabi-plugins/contents/.claude-plugin/marketplace.json \
     -H "Accept: application/vnd.github.raw+json" \
     | jq -r '.plugins[] | [.name, .description, (.category // "other")] | @tsv'
   ```
   API failure → fall back to **Static fallback list** below.

3. Check already-installed plugins:
   ```bash
   claude plugin list --json 2>/dev/null | jq -r '.[].name' || claude plugin list 2>/dev/null
   ```

4. Filter: remove `dev-core` + any already-installed plugin from the discovered list.

5. Group remaining plugins by `category` (from the tsv above). ∀ group:
   - Print: `### <Category>` + `| Plugin | Description |` table
   - Ask: **Install all** | **Pick** | **Skip**
   - Pick → Ask per plugin: **Install** | **Skip**
   - Install: `claude plugin install <name>`

### 3b — Curated external marketplaces

Fetch the endorsed external marketplaces from our catalog:
```bash
gh api repos/Roxabi/roxabi-plugins/contents/.claude-plugin/curated-marketplaces.json \
  -H "Accept: application/vnd.github.raw+json" \
  | jq -r '.marketplaces[] | [.source, .description, (.recommended // [] | join(","))] | @tsv'
```

These are proper plugin marketplaces we endorse but haven't wrapped ourselves. Empty list → D⏭("Curated marketplaces — none configured"), skip.

∀ marketplace in the result:
1. Fetch its plugin list:
   ```bash
   gh api repos/<source>/contents/.claude-plugin/marketplace.json \
     -H "Accept: application/vnd.github.raw+json" \
     | jq -r '.plugins[] | [.name, .description] | @tsv'
   ```
   If `recommended` is non-empty, pre-filter to those names only.
2. Present plugins not already installed.
3. Ask: **Install all** | **Pick** | **Skip**
4. Install: `claude plugin marketplace add <source> 2>/dev/null || true && claude plugin install <name>`

### 3c — Static fallback (GitHub API unavailable)

Use this list if `gh api` fails in 3a:

| Plugin | Category | What it does |
|--------|----------|-------------|
| `compress` | dev-tools | Rewrite agent/skill definitions in compact math/logic notation |
| `1b1` | dev-tools | Walk a list one by one: brief → decide → act → next |
| `web-intel` | dev-tools | Scrape Twitter/X, GitHub, YouTube, Reddit — summarize, analyze |
| `react-best-practices` | frontend | 58 React/Next.js perf rules across 8 categories |
| `composition-patterns` | frontend | Avoid boolean prop proliferation — compound components |
| `web-design-guidelines` | frontend | Review UI for accessibility, UX, and Web Interface Guidelines |
| `visual-explainer` | visual | Self-contained HTML pages with diagrams and data tables |
| `frontend-slides` | visual | Zero-dependency HTML presentations — 12 presets, PPT conversion |
| `image-prompt-generator` | visual | AI image prompts with visual identity and style consistency |
| `cv` | career | Generate and adapt CVs from structured JSON |
| `linkedin-apply` | career | Score LinkedIn jobs against your profile — APPLY / REVIEW / SKIP |
| `linkedin-post-generator` | career | Engaging LinkedIn posts with best practices |
| `vault` | data | Unified local SQLite+FTS5 vault — CRUD and full-text search |
| `get-invoice-details` | data | Extract structured data from invoice documents → JSON |

After all groups: D("Marketplace plugins", "installed: name, name, ... (or: ⏭ None installed)").
