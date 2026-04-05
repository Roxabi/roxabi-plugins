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

# sync_cache_safe REPO CACHE — snapshot cache, sync, restore on failure
# Wraps sync_cache with rollback-on-failure. Prevents partial-sync inconsistency
# when editing many SKILL.md files at once (e.g. the dev-core chain contract refactor).
sync_cache_safe() {
    local repo="$1"
    local cache="$2"
    local backup
    backup="$(mktemp -d "${TMPDIR:-/tmp}/sync-plugins-backup.XXXXXX")"

    # Rollback closure — restores cache from snapshot on ERR or INT
    _sync_rollback() {
        warn "Sync failed — rolling back cache from $backup"
        rsync -a --delete "$backup/" "$cache/"
        rm -rf "$backup"
        warn "Rollback complete — cache restored to pre-sync state"
        exit 1
    }

    step "Snapshotting cache to $backup before sync..."
    if [ -d "$cache" ]; then
        rsync -a "$cache/" "$backup/"
    else
        warn "Cache dir $cache does not exist — nothing to snapshot"
    fi

    # Install trap AFTER snapshot so the snapshot itself failing doesn't trigger rollback
    trap _sync_rollback ERR INT

    # Delegate to the regular sync function — any rsync failure triggers the trap
    sync_cache "$repo" "$cache"

    # Success — remove trap + backup
    trap - ERR INT
    rm -rf "$backup"
    echo -e "${GREEN}  rollback snapshot discarded (sync succeeded)${NC}"
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

    step "Syncing all plugins → local cache (with rollback-on-failure)..."
    sync_cache_safe "$MARKETPLACE_REPO" "$CACHE_BASE"
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
