#!/usr/bin/env bash
# Sync vendored Vercel skills from upstream.
# Usage: ./tools/sync-vercel-skills.sh
#
# Clones (or pulls) vercel-labs/agent-skills into a local cache,
# then copies AGENTS.md and rules/ into each plugin's references/ dir.
# Our SKILL.md and README.md are never overwritten — only upstream
# content files are synced.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_URL="https://github.com/vercel-labs/agent-skills.git"
UPSTREAM_BRANCH="main"
CACHE_DIR="$REPO_ROOT/.cache/vercel-agent-skills"

# Skills to sync: <upstream-dir> → <local-plugin-dir>
declare -A SKILLS=(
  [react-best-practices]="react-best-practices"
  [composition-patterns]="composition-patterns"
  [web-design-guidelines]="web-design-guidelines"
)

# ── Step 1: Clone or pull upstream ──────────────────────────────────────────
echo "==> Fetching upstream: $UPSTREAM_URL ($UPSTREAM_BRANCH)"
if [ -d "$CACHE_DIR/.git" ]; then
  git -C "$CACHE_DIR" fetch origin "$UPSTREAM_BRANCH" --quiet
  git -C "$CACHE_DIR" reset --hard "origin/$UPSTREAM_BRANCH" --quiet
  echo "    Pulled latest changes."
else
  mkdir -p "$(dirname "$CACHE_DIR")"
  git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_URL" "$CACHE_DIR" --quiet
  echo "    Cloned fresh."
fi

# ── Step 2: Sync each skill ─────────────────────────────────────────────────
for upstream_skill in "${!SKILLS[@]}"; do
  local_plugin="${SKILLS[$upstream_skill]}"
  src="$CACHE_DIR/skills/$upstream_skill"
  dest="$REPO_ROOT/plugins/$local_plugin/skills/$local_plugin/references"

  if [ ! -d "$src" ]; then
    echo "    SKIP $upstream_skill — not found in upstream repo"
    continue
  fi

  echo "==> Syncing $upstream_skill"
  mkdir -p "$dest"

  # Copy AGENTS.md if it exists (compiled rules)
  if [ -f "$src/AGENTS.md" ]; then
    cp "$src/AGENTS.md" "$dest/AGENTS.md"
    echo "    Copied AGENTS.md"
  fi

  # Copy rules/ directory if it exists
  if [ -d "$src/rules" ]; then
    rsync -a --delete "$src/rules/" "$dest/rules/"
    echo "    Synced rules/"
  fi

  # Copy metadata.json if it exists
  if [ -f "$src/metadata.json" ]; then
    cp "$src/metadata.json" "$dest/metadata.json"
    echo "    Copied metadata.json"
  fi
done

# ── Step 3: Show upstream commit ─────────────────────────────────────────────
COMMIT=$(git -C "$CACHE_DIR" rev-parse --short HEAD)
DATE=$(git -C "$CACHE_DIR" log -1 --format='%ci')
echo ""
echo "==> Done. Synced from upstream commit $COMMIT ($DATE)"
echo "    Review changes with: git diff --stat"
