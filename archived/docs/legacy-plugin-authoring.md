# Historical plugin wrapping and subtree authoring

**Historical procedure, not current contributor guidance or runtime support.**
Preserved from the former `docs/CREATE-PLUGIN-GUIDE.md` (now `archived/docs/`) § Forking an Upstream
Plugin and `CONTRIBUTING.md` § Upstream sync during the approved repository
cleanup. The examples below describe the old wrapper/vendor model; they do not
authorize installing, deleting, syncing, committing or publishing anything.

For current authoring and active external curation, use the maintained
[`CONTRIBUTING.md` § Creating a new plugin](../../CONTRIBUTING.md#creating-a-new-plugin) and
[§ External marketplace curation](../../CONTRIBUTING.md#external-marketplace-curation). In particular,
the historical registry equality and orphan-directory rules below are not the
current active-entry projection or archive/untracked-directory policy.

## Forking an upstream plugin — former guide

When adopting a high-quality external skill rather than building from scratch,
the former guide used `git subtree` to vendor it into the marketplace while
keeping the ability to pull upstream updates.

> **Native vs Wrapped plugins** — plugins built by Roxabi were called *native*.
> Plugins forked from external raw-skill repos (no versioning, no install
> mechanism) were called *wrapped*: Roxabi added the plugin structure
> (frontmatter, README, marketplace entries) and vendored the source via
> `git subtree`. Both appeared in `.claude-plugin/marketplace.json` and
> `.omp-plugin/marketplace.json`. Endorsed external repos that already shipped as
> proper plugin marketplaces went into `curated-marketplaces.json` instead of
> being vendored. There was no install-time skill that offered them.

### Step 1 — Add as a subtree

```bash
git subtree add --prefix=plugins/<plugin-name> \
  https://github.com/<owner>/<repo>.git main --squash
```

This copied all files into `plugins/<plugin-name>/` as a normal commit rather
than a submodule.

### Step 2 — Restructure into marketplace layout

The external skill could have a flat structure. The old procedure moved files
into the standard layout:

```bash
mkdir -p plugins/<plugin-name>/skills/<skill-name>
mv plugins/<plugin-name>/SKILL.md plugins/<plugin-name>/skills/<skill-name>/
# move any supporting files alongside SKILL.md
```

### Step 3 — Adapt the frontmatter

The former required fields were added to the upstream SKILL.md:

```yaml
---
name: skill-name
description: 'One-line description. Triggers: "phrase1" | "phrase2".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---
```

### Step 4 — Replace the README

The upstream README was replaced with a Roxabi marketplace README describing
installation, trigger phrases and operation, with a “Forked from” credit.

### Steps 5–6 — Register and commit

The former guide referred back to its new-plugin registration steps: both
marketplace catalogs, plugin metadata, the root README row, validation and the
conventional commit. That old two-catalog instruction did not describe today's
OMP-only product scope; current registration belongs to the maintained guide.

### Pulling upstream updates later

```bash
git subtree pull --prefix=plugins/<plugin-name> \
  https://github.com/<owner>/<repo>.git main --squash
```

The guide recommended minimal local frontmatter/README changes to limit merge
conflicts and recording the pull command in the commit message.

## Upstream sync — former contributing procedure

The former workflow covered both wrapped plugins and curated marketplaces,
periodically or after an `upstream-update` issue. It is retained here as history.

### 1. Check curated marketplaces for drift

For each entry in `external-registry.json` → `curated_marketplaces`, compare the
stored SHA to upstream HEAD:

```bash
# Compare stored SHA against upstream HEAD
git ls-remote <source>.git refs/heads/<branch> | awk '{print $1}'
```

If it differed from `last_checked_commit`, the former procedure fetched
`gh api repos/<owner>/<repo>/compare/<old_sha>...<branch>`, reviewed renamed
skills/removed files/new dependencies, then updated `last_checked_commit`.
Current active curation is documented separately in the external ecosystem reference.

### 2. Check wrapped plugins for content changes

For each former `wrapped_plugins` entry:

```bash
# Clone upstream shallow
git clone --depth 1 <upstream_url> /tmp/<name>-upstream

# Diff file trees (our references/ layout vs upstream flat layout)
diff <(cd /tmp/<name>-upstream/<path> && find . -type f | sort) \
     <(cd plugins/<name>/skills/<skill>/references && find . -type f | sort)

# Diff content of matching files
diff /tmp/<name>-upstream/<path>/rules/<file>.md \
     plugins/<name>/skills/<skill>/references/rules/<file>.md
```

New upstream files were copied into `references/`; changed content was reviewed
and merged while intentionally different frontmatter was skipped. The registry
then recorded `last_sync_commit` and `last_sync_date`.

### 3. Check if wrapped plugins should be promoted

The old procedure checked whether upstream had become a proper marketplace:

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/contents/.claude-plugin" | jq '.[].name'
```

When upstream shipped `.claude-plugin/marketplace.json` with versioned plugins,
the former promotion sequence was:

1. `git rm -r plugins/<name>/`.
2. Remove the Claude marketplace row.
3. Add `curated_marketplaces` in `external-registry.json` and the mirror entry in
   `.claude-plugin/curated-marketplaces.json`.
4. Move the entry to the root README's endorsed marketplaces table.

This is a historical deletion recipe, not authorization to remove tracked or
local untracked plugin directories during current work.

### 4. Consistency check

The former checklist required full curated-name equality between registry and
mirror, existing marketplace source directories, no orphan plugin directories,
and every endorsed marketplace listed in the README. These are preserved as the
old model, not instructions to treat deprecated entries as active or delete local
uncatalogued folders.

### 5. Commit and push

The former procedure ended with one conventional commit per logical change:

```text
chore(plugins): sync upstream — 6 new react rules + register wrapped plugins
refactor(plugins): promote visual-explainer to curated marketplace
fix(registry): add missing entry to curated-marketplaces
```

No wrapper runtime, subtree automation or cache refresh is added by preserving
this document.
