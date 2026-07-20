#!/usr/bin/env bash
# Usage: preflight.sh
# Fetches latest, reports commits ahead, open PRs on staging, and CI status.
set -euo pipefail

# ── Trunk-mode guard (#371 N17) — MUST be first ──
# A repo on release.model: trunk releases at merge-to-main (auto-release.yml),
# never via a staging→main promote. /promote does not apply, and a trunk repo may
# have no `staging` branch — so this precedes the staging fetch below. Read the
# model with a yq → python3 → default chain so the guard never goes inert when
# yq is absent on CI; default staging-train keeps existing repos unaffected (N9).
read_release_model() {
  local stack=".claude/stack.yml"
  [ -f "$stack" ] || { echo staging-train; return; }
  if command -v yq >/dev/null 2>&1; then
    yq -r '.release.model // "staging-train"' "$stack"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,yaml; d=yaml.safe_load(open(sys.argv[1])) or {}; print(((d.get("release") or {}).get("model")) or "staging-train")' "$stack"
  else
    echo staging-train
  fi
}
RELEASE_MODEL=$(read_release_model)
if [ "${RELEASE_MODEL:-staging-train}" = "trunk" ]; then
  # Narrowed guard (#371 B1). Under trunk, auto-release.yml is the SOLE tagger at
  # merge-to-main, so /promote must never tag — its --finalize step is refused
  # (SKILL.md Step 9). But the staging→main *merge PR* never tags, and it is still
  # how a repo that keeps a `staging` branch through the trunk transition gets
  # commits onto main (where auto-release.yml then fires). So allow the create-PR
  # flow when a staging branch exists; a pure trunk repo (no staging) has nothing
  # to promote → clean no-op. Local ref check (no network) so it runs before the
  # staging fetch below and stays deterministic under test.
  if git rev-parse --verify --quiet refs/heads/staging >/dev/null 2>&1 \
     || git rev-parse --verify --quiet refs/remotes/origin/staging >/dev/null 2>&1; then
    echo "status=trunk_promote_pr"
    echo "release.model==trunk — /promote opens the staging→main merge PR only; auto-release.yml tags on merge, and --finalize is refused (single writer)."
    # fall through to the normal pre-flight below (fetch, commits-ahead, CI).
  else
    echo "status=trunk_mode"
    echo "release.model==trunk with no staging branch — /promote does not apply; releases fire at merge-to-main (auto-release.yml)."
    exit 0
  fi
fi

# Branch names are intentionally hardcoded: promote always operates on the fixed
# staging→main pair, so detect_base_branch (single-base detection) does not apply here.
# Each git op emits a machine-readable status= key before exiting non-zero so the
# /promote skill sees a reason rather than a bare set -e abort.
git fetch origin staging main 2>&1 || { echo "status=fetch_failed"; exit 1; }
git checkout staging 2>&1 || { echo "status=checkout_failed"; exit 1; }
git pull origin staging 2>&1 || { echo "status=pull_failed"; exit 1; }

# `|| true` keeps a git-log failure from aborting under `set -e` so the guard
# below can report a structured status instead of a bare non-zero exit.
COMMITS=$(git log main..staging --oneline 2>/dev/null | wc -l | tr -d '[:space:]' || true)
COMMITS=${COMMITS:-0}
echo "commits_ahead=$COMMITS"
if ! [ "$COMMITS" -eq "$COMMITS" ] 2>/dev/null; then
  echo "status=error_counting_commits"
elif [ "$COMMITS" -eq 0 ]; then
  echo "status=nothing_to_promote"
else
  echo "status=ok"
fi

echo "---commits---"
git log main..staging --oneline 2>/dev/null || echo "none"

echo "---stat---"
git diff main...staging --stat 2>/dev/null || echo "none"

echo "---open_prs_on_staging---"
gh pr list --base staging --state open --json number,title,headRefName 2>/dev/null || echo "none"

echo "---ci---"
gh api repos/:owner/:repo/commits/staging/check-runs \
  --jq '[.check_runs[] | {name, conclusion}] | group_by(.conclusion) | map({conclusion: .[0].conclusion, count: length})' \
  2>/dev/null || echo "ci=unknown"

echo "---hotfix_density---"
# Advisory-only: compute hotfix density since last tag/promotion-merge/30d fallback.
# Never exits non-zero; failures emit a structured error line.
# BASH_SOURCE resolves to the real skill-dir path at runtime (cache or marketplace);
# bun runs the .ts source directly (no build step) — its import.meta.main block wires
# the git/gh IO deps and prints the formatted line.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun run "${SCRIPT_DIR}/lib/hotfix-density.ts" 2>/dev/null || echo "hotfix_density=error"
