#!/usr/bin/env bash
set -euo pipefail
# #656: omp-build 0.8.0 is the OMP cache key for the skill changes in #652
# (PR #664) and #655 (PR #665). Publishing that stamp while those merges are
# not ancestors of HEAD leaves the catalogue bump covering a tree they are
# not in. A later catalogue version makes this check a no-op.
version=$(bun -e '
const doc = JSON.parse(await Bun.file(".omp-plugin/marketplace.json").text())
const row = (doc.plugins ?? []).find((plugin) => plugin && plugin.name === "omp-build")
console.log(typeof row?.version === "string" ? row.version : "")
')
if [ "$version" != "0.8.0" ]; then
  exit 0
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "cannot verify .omp-plugin/marketplace.json 0.8.0 covers #652 and #655 — gh missing"
  exit 1
fi
for pr in 664 665; do
  if ! state=$(gh pr view "$pr" --json state --jq .state); then
    echo "cannot verify .omp-plugin/marketplace.json 0.8.0 covers #$pr"
    exit 1
  fi
  if [ "$state" != "MERGED" ]; then
    echo "omp-build 0.8.0 cannot publish before #$pr is merged (state: $state) — .omp-plugin/marketplace.json"
    exit 1
  fi
  if ! sha=$(gh pr view "$pr" --json mergeCommit --jq .mergeCommit.oid); then
    echo "cannot read the merge commit of #$pr for .omp-plugin/marketplace.json"
    exit 1
  fi
  if ! git fetch --quiet origin "$sha"; then
    echo "cannot fetch the merge commit of #$pr for .omp-plugin/marketplace.json"
    exit 1
  fi
  if ! git merge-base --is-ancestor "$sha" HEAD; then
    echo "#$pr merge $sha is not an ancestor of HEAD — .omp-plugin/marketplace.json 0.8.0 does not cover it"
    exit 1
  fi
done
