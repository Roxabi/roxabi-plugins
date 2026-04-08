# External Ecosystem

Roxabi endorses and vendors external Claude Code plugins via two mechanisms. The registry
`.claude-plugin/external-registry.json` is the source of truth for all external sources.

> **Upstream sync** — see [CONTRIBUTING.md § Upstream sync](CONTRIBUTING.md#upstream-sync) for the full process to check drift, pull changes, promote wrapped plugins, and run consistency checks.

## Directory convention

| Directory | Contents |
|-----------|----------|
| `plugins/` | Native Roxabi plugins — built and owned by Roxabi |
| `external/` | Curated/vendored external plugins — sourced from upstream repos |

Both appear in `.claude-plugin/marketplace.json` so users install them the same way.

> **Note:** The `external/` directory is created when the first external plugin is vendored (see issue #63 — initial audit). This section documents the convention for when it exists.

## Case 1 — Curated Marketplace

An external repo that is itself a proper plugin marketplace (has `marketplace.json`, versioned
installs, works with `claude plugin marketplace add <url>`). Users install from it directly —
no vendoring into this repo.

**Qualify if ALL:**
- [ ] Ships `marketplace.json` with versioned plugins
- [ ] Has working install mechanism (`claude plugin marketplace add <url>`)
- [ ] Last commit ≤ 90 days ago
- [ ] Reviewed skills with clear descriptions + trigger phrases
- [ ] < 50% overlap with native Roxabi plugins

**To add a curated marketplace:**
1. Verify all criteria above manually
2. Add entry to `.claude-plugin/external-registry.json` under `curated_marketplaces`
   - Optional: set `upstream_branch` to track a specific branch (e.g. `main`). Without it, CI checks `HEAD`.
3. Sync to `.claude-plugin/curated-marketplaces.json` `marketplaces` array

## Case 2 — Wrapped Plugin

A raw skill repo (SKILL.md files, no install mechanism) vendored into `external/`. Choose
strategy at wrapping time — record in `sync_strategy` field.

**Qualify if ALL:**
- [ ] High-quality SKILL.md (clear instructions, scoped triggers)
- [ ] Last commit ≤ 90 days ago
- [ ] Fills a gap not covered by native plugins
- [ ] Compatible license (MIT, Apache 2.0, etc.)
- [ ] Upstream author notified/credited in plugin README

**Copy strategy** (flat SKILL.md repos — simpler, no merge conflicts):
```bash
# 1. Copy files into external/
cp -r <upstream-skill-dir>/ external/<name>/
# 2. Record upstream HEAD SHA
SHA=$(git ls-remote <repo-url>.git refs/heads/main | awk '{print $1}')
# 3. Add to external-registry.json (sync_strategy: "copy", last_sync_commit: "$SHA")
# 4. Add to marketplace.json ("source": "./external/<name>")
```

**Subtree strategy** (plugins with meaningful directory structure):
```bash
git subtree add --prefix=external/<name> <url>.git <branch> --squash
# Add to external-registry.json (sync_strategy: "subtree", subtree_prefix: "external/<name>")
# Add to marketplace.json ("source": "./external/<name>")
```

**To update a wrapped plugin:**

Copy strategy:
```bash
SHA=$(git ls-remote <repo-url>.git refs/heads/main | awk '{print $1}')
cp -r <upstream-skill-dir>/ external/<name>/
# Update external-registry.json: last_sync_commit, last_sync_date
```

Subtree strategy:
```bash
git subtree pull --prefix=external/<name> <url>.git <branch> --squash
# Update external-registry.json: last_sync_commit, last_sync_date
```

## Case 3 — Deprecation

**Trigger if ANY:**
- Upstream archived/deleted with no suitable replacement
- > 12 months since last commit (any commit counts)
- Superseded by a better native or external alternative
- License changed to incompatible terms

**To deprecate:**
1. Set `status: deprecated` in `external-registry.json` entry
2. Remove from `marketplace.json` (wrapped) or `curated-marketplaces.json` (curated)
3. Optionally remove plugin directory: `git rm -r external/<name>` (wrapped only)
4. Add deprecation date + reason to `notes` field in registry

## Upstream drift detection

CI runs weekly (Mondays 09:00 UTC) and on manual dispatch via `.github/workflows/upstream-watch.yml`.
When upstream has new commits vs `last_sync_commit`, it opens a GitHub issue labelled `upstream-update`.
Review the diff and decide: update, skip, or deprecate. **CI never auto-merges.**

Trigger manually: GitHub Actions → Upstream Watch → Run workflow.
