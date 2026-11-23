#!/usr/bin/env bash
# Decisions behind the required `review` check (#1032), from text and Git objects
# only. .github/workflows/review-verdict.yml reads GitHub and posts the check.
#
#   review-verdict.sh verdict <comment-file> <pr-state> <pr-head>
#     Accepts one line `review-verdict v1 head=<sha> approve evidence=<https url>`
#     naming the head of an open PR. Prints the evidence URL.
#   review-verdict.sh carry <head> <base-ref>
#     Accepts a head that is the clean merge of a first parent with a commit of
#     <base-ref>, as `gh pr update-branch` makes. Prints that first parent, whose
#     own `review` check the workflow still has to confirm.
#
# A refusal exits 1 with its reason on stderr.
set -euo pipefail

refuse() {
  printf '%s\n' "$1" >&2
  exit 1
}

verdict() {
  local file=$1 state=$2 head=$3 lines line named
  lines=$(tr -d '\r' <"$file" | grep -E '^review-verdict v1 head=[0-9a-f]{40} approve evidence=https://[^[:space:]]+$' || true)
  [ -n "$lines" ] || refuse 'no well-formed verdict line'
  [ "$(printf '%s\n' "$lines" | wc -l)" -eq 1 ] || refuse 'more than one verdict line'
  line=$lines
  named=${line#review-verdict v1 head=}
  named=${named%% *}
  [ "$state" = open ] || refuse "pull request is $state"
  [ "$named" = "$head" ] || refuse "verdict names $named, pull request head is $head"
  printf '%s\n' "${line##* evidence=}"
}

carry() {
  local head=$1 base=$2 parents merged
  read -r -a parents <<<"$(git rev-list --parents -n 1 "$head")"
  [ "${#parents[@]}" -eq 3 ] || refuse "$head is not a two-parent merge"
  git merge-base --is-ancestor "${parents[2]}" "$base" || refuse "second parent ${parents[2]} is not on $base"
  merged=$(git merge-tree --write-tree "${parents[1]}" "${parents[2]}") || refuse 'parents do not merge cleanly'
  [ "$merged" = "$(git rev-parse "$head^{tree}")" ] || refuse "$head tree differs from the clean merge of its parents"
  printf '%s\n' "${parents[1]}"
}

case "${1:-}" in
  verdict) [ $# -eq 4 ] || refuse 'usage: review-verdict.sh verdict <comment-file> <pr-state> <pr-head>'; verdict "$2" "$3" "$4" ;;
  carry) [ $# -eq 3 ] || refuse 'usage: review-verdict.sh carry <head> <base-ref>'; carry "$2" "$3" ;;
  *) refuse 'usage: review-verdict.sh verdict|carry …' ;;
esac
