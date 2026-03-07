#!/usr/bin/env bash
# sync-plugins.sh — Push, pull, and sync roxabi-plugins across machines + caches
#
# Usage:
#   ./sync-plugins.sh              # sync everything
#   ./sync-plugins.sh --local      # sync local only (no Machine 1)
#   ./sync-plugins.sh --remote     # sync Machine 1 only (no local)
#
# Flow:
#   1. Push staging to origin
#   2. Pull staging into local marketplace clone
#   3. Rsync marketplace → local plugin cache
#   4. Pull staging on Machine 1 marketplace
#   5. Rsync Machine 1 marketplace → Machine 1 plugin cache

set -euo pipefail

# Config
REMOTE_HOST="mickael@192.168.1.16"
MARKETPLACE_REPO="$HOME/.claude/plugins/marketplaces/roxabi-marketplace"
CACHE_BASE="$HOME/.claude/plugins/cache/roxabi-marketplace"
PLUGIN="dev-core"
CACHE_VERSION="0.1.0"

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

    step "Syncing marketplace → local cache (${PLUGIN})..."
    rsync -av --delete \
        "$MARKETPLACE_REPO/plugins/$PLUGIN/" \
        "$CACHE_BASE/$PLUGIN/$CACHE_VERSION/"

    # Also sync roxabi_sdk (shared dependency)
    rsync -av --delete \
        "$MARKETPLACE_REPO/roxabi_sdk/" \
        "$CACHE_BASE/$PLUGIN/$CACHE_VERSION/roxabi_sdk/"

    echo -e "${GREEN}✓ Local cache updated${NC}"
fi

# Step 4-5: Remote sync (Machine 1)
if [[ "$DO_REMOTE" == true ]]; then
    step "Pulling staging on Machine 1 marketplace..."
    ssh "$REMOTE_HOST" "cd $MARKETPLACE_REPO && git fetch origin && git merge --ff-only origin/staging"

    step "Syncing marketplace → cache on Machine 1 (${PLUGIN})..."
    ssh "$REMOTE_HOST" "rsync -av --delete \
        $MARKETPLACE_REPO/plugins/$PLUGIN/ \
        $CACHE_BASE/$PLUGIN/$CACHE_VERSION/ && \
        rsync -av --delete \
        $MARKETPLACE_REPO/roxabi_sdk/ \
        $CACHE_BASE/$PLUGIN/$CACHE_VERSION/roxabi_sdk/"

    echo -e "${GREEN}✓ Machine 1 cache updated${NC}"
fi

echo -e "${GREEN}✓ All done${NC}"
