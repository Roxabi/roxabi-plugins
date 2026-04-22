#!/usr/bin/env bash
# sync-plugins.sh — Push, pull, and sync Roxabi plugins across machines + caches
#
# Usage:
#   ./sync-plugins.sh              # sync everything (local + remote)
#   ./sync-plugins.sh --local      # sync local cache only
#   ./sync-plugins.sh --remote     # sync Machine 1 cache only
#
# Flow:
#   1. Push staging to origin (for the repo where script runs)
#   2. Discover brother marketplaces (git repos w/ staging branch)
#   3. Pull staging into each local marketplace
#   4. Rsync plugins/skills → all local cache dirs
#   5. Repeat on Machine 1 if --remote

set -euo pipefail

# Config
REMOTE_HOST="mickael@192.168.1.16"
MARKETPLACES_DIR="$HOME/.claude/plugins/marketplaces"
CACHE_BASE="$HOME/.claude/plugins/cache"
SCRIPT_REPO="$(cd "$(dirname "$0")" && pwd)"

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

# Step 1: Push current branch to origin (only for the repo containing this script)
CURRENT_BRANCH=$(git -C "$SCRIPT_REPO" rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "staging" ]]; then
    warn "Not on staging (on '$CURRENT_BRANCH') — aborting push to prevent pushing wrong branch"
    exit 1
fi
step "Pushing staging to origin..."
git -C "$SCRIPT_REPO" push origin staging

# discover_roxabi_marketplaces — find all marketplaces with staging branch
discover_roxabi_marketplaces() {
    local marketplaces=()
    for dir in "$MARKETPLACES_DIR"/*/; do
        local name
        name=$(basename "$dir")
        # Skip if not a git repo
        [[ -d "$dir/.git" ]] || continue
        # Check for staging branch
        if git -C "$dir" rev-parse --verify staging &>/dev/null; then
            marketplaces+=("$name")
        fi
    done
    echo "${marketplaces[@]}"
}

ROXABI_MARKETPLACES=$(discover_roxabi_marketplaces)
step "Discovered Roxabi marketplaces: ${ROXABI_MARKETPLACES}"

# sync_cache MARKETPLACE — rsync plugins/skills into all cache dirs for a marketplace
# Handles two structures:
#   1. plugins/<plugin-name>/ (roxabi-marketplace, lyra-marketplace, roxabi-forge)
#   2. skills/ at root (roxabi-vault-marketplace, voicecli-marketplace)
sync_cache() {
    local marketplace="$1"
    local repo="$MARKETPLACES_DIR/$marketplace"
    local cache="$CACHE_BASE/$marketplace"
    local count=0

    [[ -d "$cache" ]] || { warn "Cache $cache does not exist — skipping"; return; }

    # Structure 1: plugins/<plugin-name>/
    if [[ -d "$repo/plugins" ]]; then
        for plugin_dir in "$repo/plugins"/*/; do
            local plugin
            plugin=$(basename "$plugin_dir")
            [[ -d "$cache/$plugin" ]] || continue

            for hash_dir in "$cache/$plugin"/*/; do
                local name
                name=$(basename "$hash_dir")
                # Skip non-cache dirs — only sync into semver (0.1.0) or hex-hash
                [[ "$name" == ".claude-plugin" ]] && continue
                [[ ! "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && ! "$name" =~ ^[0-9a-f]{12}$ ]] && continue

                rsync -a \
                    --exclude='__tests__' \
                    --exclude='node_modules' \
                    --exclude='.orphaned_at' \
                    --exclude='.dashboard.pid' \
                    "$plugin_dir" "$hash_dir"

                # Sync roxabi_sdk if present
                [[ -d "$repo/roxabi_sdk" ]] && rsync -a "$repo/roxabi_sdk/" "$hash_dir/roxabi_sdk/"

                echo "  synced $plugin → $name"
                (( count++ )) || true
            done
        done
    fi

    # Structure 2: skills/ at root (marketplace = single plugin)
    # Cache is: cache/<marketplace>/<plugin>/<version>/
    # Need to sync skills/ into each plugin's version dirs
    if [[ -d "$repo/skills" ]] && [[ ! -d "$repo/plugins" ]]; then
        for plugin_dir in "$cache"/*/; do
            local plugin
            plugin=$(basename "$plugin_dir")
            [[ "$plugin" == ".claude-plugin" ]] && continue

            for hash_dir in "$plugin_dir"*/; do
                local name
                name=$(basename "$hash_dir")
                [[ ! "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && ! "$name" =~ ^[0-9a-f]{12}$ ]] && continue

                rsync -a \
                    --exclude='__tests__' \
                    --exclude='node_modules' \
                    "$repo/skills/" "$hash_dir/skills/"

                # Sync other common dirs
                [[ -d "$repo/roxabi_vault" ]] && rsync -a "$repo/roxabi_vault/" "$hash_dir/roxabi_vault/"
                [[ -d "$repo/src" ]] && rsync -a "$repo/src/" "$hash_dir/src/"
                [[ -f "$repo/pyproject.toml" ]] && cp "$repo/pyproject.toml" "$hash_dir/"

                echo "  synced skills → $plugin/$name"
                (( count++ )) || true
            done
        done
    fi

    echo -e "${GREEN}  $count cache dir(s) updated${NC}"
}

# sync_cache_safe MARKETPLACE — snapshot cache, sync, restore on failure
sync_cache_safe() {
    local marketplace="$1"
    local cache="$CACHE_BASE/$marketplace"
    local backup
    backup="$(mktemp -d "${TMPDIR:-/tmp}/sync-plugins-backup.XXXXXX")"

    _sync_rollback() {
        warn "Sync failed — rolling back cache from $backup"
        rsync -a --delete "$backup/" "$cache/"
        rm -rf "$backup"
        warn "Rollback complete — cache restored to pre-sync state"
        exit 1
    }

    step "Snapshotting $marketplace cache to $backup..."
    if [ -d "$cache" ]; then
        rsync -a "$cache/" "$backup/"
    else
        warn "Cache dir $cache does not exist — nothing to snapshot"
    fi

    trap _sync_rollback ERR INT
    sync_cache "$marketplace"
    trap - ERR INT
    rm -rf "$backup"
    echo -e "${GREEN}  rollback snapshot discarded (sync succeeded)${NC}"
}

# Step 2-3: Local sync — iterate over all Roxabi marketplaces
if [[ "$DO_LOCAL" == true ]]; then
    for marketplace in $ROXABI_MARKETPLACES; do
        local_repo="$MARKETPLACES_DIR/$marketplace"

        step "Pulling staging into $marketplace..."
        git -C "$local_repo" fetch origin
        git -C "$local_repo" checkout staging
        git -C "$local_repo" merge --ff-only origin/staging

        step "Syncing $marketplace → local cache..."
        sync_cache_safe "$marketplace"
    done
    echo -e "${GREEN}✓ All local caches updated${NC}"
fi

# Step 4-5: Remote sync (Machine 1)
if [[ "$DO_REMOTE" == true ]]; then
    for marketplace in $ROXABI_MARKETPLACES; do
        # Skip if marketplace doesn't exist on remote
        if ! ssh "$REMOTE_HOST" "[ -d '$MARKETPLACES_DIR/$marketplace' ]" 2>/dev/null; then
            warn "Marketplace $marketplace not found on M1 — skipping"
            continue
        fi

        step "Pulling staging on Machine 1 for $marketplace..."
        ssh "$REMOTE_HOST" "cd '$MARKETPLACES_DIR/$marketplace' && git fetch origin && git merge --ff-only origin/staging"

        step "Syncing $marketplace → Machine 1 cache..."
        ssh "$REMOTE_HOST" "
            set -euo pipefail
            marketplace='$marketplace'
            repo='$MARKETPLACES_DIR/\$marketplace'
            cache='$CACHE_BASE/\$marketplace'
            count=0

            # Structure 1: plugins/<plugin-name>/
            if [ -d \"\$repo/plugins\" ]; then
                for plugin_dir in \"\$repo/plugins\"/*/; do
                    plugin=\$(basename \"\$plugin_dir\")
                    [ -d \"\$cache/\$plugin\" ] || continue
                    for hash_dir in \"\$cache/\$plugin\"/*/; do
                        name=\$(basename \"\$hash_dir\")
                        [[ \"\$name\" == '.claude-plugin' ]] && continue
                        [[ ! \"\$name\" =~ ^[0-9]+\.[0-9]+\.[0-9]+\$ && ! \"\$name\" =~ ^[0-9a-f]{12}\$ ]] && continue
                        rsync -a --exclude='__tests__' --exclude='node_modules' \"\$plugin_dir\" \"\$hash_dir\"
                        [ -d \"\$repo/roxabi_sdk\" ] && rsync -a \"\$repo/roxabi_sdk/\" \"\$hash_dir/roxabi_sdk/\"
                        echo \"  synced \$plugin → \$name\"
                        (( count++ )) || true
                    done
                done
            fi

            # Structure 2: skills/ at root (marketplace = single plugin)
            if [ -d \"\$repo/skills\" ] && [ ! -d \"\$repo/plugins\" ]; then
                for plugin_dir in \"\$cache\"/*/; do
                    plugin=\$(basename \"\$plugin_dir\")
                    [[ \"\$plugin\" == '.claude-plugin' ]] && continue
                    for hash_dir in \"\$plugin_dir\"*/; do
                        name=\$(basename \"\$hash_dir\")
                        [[ ! \"\$name\" =~ ^[0-9]+\.[0-9]+\.[0-9]+\$ && ! \"\$name\" =~ ^[0-9a-f]{12}\$ ]] && continue
                        rsync -a --exclude='__tests__' --exclude='node_modules' \"\$repo/skills/\" \"\$hash_dir/skills/\"
                        [ -d \"\$repo/roxabi_vault\" ] && rsync -a \"\$repo/roxabi_vault/\" \"\$hash_dir/roxabi_vault/\"
                        [ -d \"\$repo/src\" ] && rsync -a \"\$repo/src/\" \"\$hash_dir/src/\"
                        echo \"  synced skills → \$plugin/\$name\"
                        (( count++ )) || true
                    done
                done
            fi

            echo \"\$count cache dir(s) updated\"
        "
    done
    echo -e "${GREEN}✓ All Machine 1 caches updated${NC}"
fi

echo -e "${GREEN}✓ All done${NC}"
