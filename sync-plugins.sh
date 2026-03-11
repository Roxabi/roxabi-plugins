#!/usr/bin/env bash
# sync-plugins.sh — Push, pull, and sync roxabi-plugins across machines + caches
#
# Usage:
#   ./sync-plugins.sh              # sync everything (local + remote)
#   ./sync-plugins.sh --local      # sync local cache only
#   ./sync-plugins.sh --remote     # sync Machine 1 cache only
#
# Flow:
#   1. Push staging to origin
#   2. Pull staging into local marketplace clone
#   3. Rsync all plugins → all local cache dirs (semver + hex-hash)
#   4. Pull staging on Machine 1 marketplace
#   5. Rsync all plugins → all Machine 1 cache dirs

set -euo pipefail

# Config
REMOTE_HOST="mickael@192.168.1.16"
MARKETPLACE_REPO="$HOME/.claude/plugins/marketplaces/roxabi-marketplace"
CACHE_BASE="$HOME/.claude/plugins/cache/roxabi-marketplace"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "${GREEN}→ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }

# Parse flags
DO_LOCAL=true
DO_REMOTE=true
if [[ "${1:-}" == "--local" ]]; then DO_REMOTE=false; fi
if [[ "${1:-}" == "--remote" ]]; then DO_LOCAL=false; fi

# Step 1: Push current branch to origin
step "Pushing staging to origin..."
git push origin staging

# sync_cache REPO CACHE — rsync all plugins into all discovered cache dirs
sync_cache() {
    local repo="$1"
    local cache="$2"
    local count=0

    for plugin_dir in "$repo/plugins"/*/; do
        local plugin
        plugin=$(basename "$plugin_dir")
        [ -d "$cache/$plugin" ] || continue

        for hash_dir in "$cache/$plugin"/*/; do
            local name
            name=$(basename "$hash_dir")
            # Skip non-cache dirs — only sync into semver (0.1.0) or hex-hash (6011eb380f4f)
            [[ "$name" == ".claude-plugin" ]] && continue
            [[ ! "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && ! "$name" =~ ^[0-9a-f]{12}$ ]] && continue

            rsync -a \
                --exclude='__tests__' \
                --exclude='node_modules' \
                --exclude='.orphaned_at' \
                --exclude='.dashboard.pid' \
                "$plugin_dir" "$hash_dir"

            # Sync roxabi_sdk into plugin root for Python imports
            rsync -a "$repo/roxabi_sdk/" "$hash_dir/roxabi_sdk/"

            echo "  synced $plugin → $name"
            (( count++ )) || true
        done
    done

    echo -e "${GREEN}  $count cache dir(s) updated${NC}"
}

# Step 2-3: Local sync
if [[ "$DO_LOCAL" == true ]]; then
    step "Pulling staging into local marketplace..."
    git -C "$MARKETPLACE_REPO" fetch origin
    if git -C "$MARKETPLACE_REPO" rev-parse --verify staging &>/dev/null; then
        git -C "$MARKETPLACE_REPO" checkout staging
        git -C "$MARKETPLACE_REPO" merge --ff-only origin/staging
    else
        git -C "$MARKETPLACE_REPO" checkout -b staging origin/staging
    fi

    step "Syncing all plugins → local cache..."
    sync_cache "$MARKETPLACE_REPO" "$CACHE_BASE"
    echo -e "${GREEN}✓ Local cache updated${NC}"
fi

# Step 4-5: Remote sync (Machine 1)
if [[ "$DO_REMOTE" == true ]]; then
    step "Pulling staging on Machine 1 marketplace..."
    ssh "$REMOTE_HOST" "cd '$MARKETPLACE_REPO' && git fetch origin && git merge --ff-only origin/staging"

    step "Syncing all plugins → Machine 1 cache..."
    ssh "$REMOTE_HOST" "
        set -euo pipefail
        repo='$MARKETPLACE_REPO'
        cache='$CACHE_BASE'
        count=0
        for plugin_dir in \"\$repo/plugins\"/*/; do
            plugin=\$(basename \"\$plugin_dir\")
            [ -d \"\$cache/\$plugin\" ] || continue
            for hash_dir in \"\$cache/\$plugin\"/*/; do
                name=\$(basename \"\$hash_dir\")
                [[ \"\$name\" == '.claude-plugin' ]] && continue
                [[ ! \"\$name\" =~ ^[0-9]+\.[0-9]+\.[0-9]+\$ && ! \"\$name\" =~ ^[0-9a-f]{12}\$ ]] && continue
                rsync -a \
                    --exclude='__tests__' --exclude='node_modules' \
                    --exclude='.orphaned_at' --exclude='.dashboard.pid' \
                    \"\$plugin_dir\" \"\$hash_dir\"
                rsync -a \"\$repo/roxabi_sdk/\" \"\$hash_dir/roxabi_sdk/\"
                echo \"  synced \$plugin → \$name\"
                (( count++ )) || true
            done
        done
        echo \"\$count cache dir(s) updated\"
    "
    echo -e "${GREEN}✓ Machine 1 cache updated${NC}"
fi

echo -e "${GREEN}✓ All done${NC}"
