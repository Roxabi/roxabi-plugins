#!/usr/bin/env bash

pr_json() { gh pr view "$PR" --repo "$REPO" --json state,mergeStateStatus,autoMergeRequest,headRefOid,statusCheckRollup; }
eligible_of() {
  local mode="$1" json="$2"
  if [[ "$mode" == merge-on-green ]]; then
    local head_sha
    head_sha=$(echo "$json" | jq -er '.headRefOid | select(type == "string" and test("^[0-9a-f]{40}$"))')
    bash "$SCRIPT_DIR/../feature/trusted-bun.sh" -e 'const auth = require(process.argv[1]); const [owner, repo, ...rest] = process.argv[2].split("/"); if (!owner || !repo || rest.length) throw new Error("invalid repository"); const policy = await auth.policyFromRepository({repo: {owner, repo}}); if (policy === null) { console.log("false"); } else { const state = await auth.readAuthorization({repo: {owner, repo}, prNumber: Number(process.argv[3]), policy}); console.log(state.allowed === true && state.scope.headSha === process.argv[4] ? "true" : "false"); }' "$SCRIPT_DIR/../feature/head-authorization.cjs" "$REPO" "$PR" "$head_sha"
  else
    echo "$json" | jq -r '.autoMergeRequest != null'
  fi
}
require_snapshot() { [[ -n "$1" ]] || { echo 'empty gh pr view' >&2; exit "$EXIT_INTERNAL"; }; }
behind_notice() { echo "behind: PR $PR is behind its base and cannot merge — run: gh pr update-branch $PR" >&2; }
dump_failed_logs() { gh run list --repo "$REPO" --commit "$1" --json databaseId,conclusion --jq '.[] | select((.conclusion | ascii_downcase) == "failure") | .databaseId' | while read -r id; do [[ -z "$id" ]] && continue; echo "----- failed run $id -----"; gh run view "$id" --repo "$REPO" --log-failed || true; done; }
print_offending() { jq -r --arg kind "$1" 'def norm: ascii_downcase; def conc: (.conclusion // "" | norm); def passing: conc == "success" or conc == "skipped" or conc == "neutral"; def failing: conc == "failure" or conc == "timed_out" or conc == "startup_failure"; .[] | select(if $kind == "FAIL" then failing elif $kind == "CANCEL" then conc == "cancelled" else (passing | not) and (failing | not) and (conc != "cancelled") end) | "\(.name)=\(.conclusion // "")"' >&2; }
kit_ci_of() {
  local sha="$1" run id status count
  run=$(gh api --paginate "repos/$REPO/commits/$sha/check-runs?check_name=merge-on-green&filter=all" | jq -rs --arg since "$SINCE" 'def trunc: sub("\\.[0-9]+Z$"; "Z"); [.[] | .check_runs[]? | select(.name == "merge-on-green") | select((.conclusion // "" | ascii_downcase) != "skipped") | ((.started_at // "") | trunc) as $start | select($since == "" or $start >= $since) | . + {started_at: $start}] | sort_by([.started_at, .id]) | last | if . == null then "" else "\(.id) \(.status // "" | ascii_downcase)" end')
  [[ -n "$run" ]] || { echo pending; return; }
  read -r id status <<<"$run"
  [[ "$status" == completed ]] || { echo pending; return; }
  count=$(gh api --paginate "repos/$REPO/check-runs/$id/annotations" | jq -s '[.[][]? | select(.title == "kit-ci not configured" or .title == "Manual merge required")] | length')
  (( count > 0 )) && echo unconfigured || echo configured
}
watch_checks() {
  CONFIRMED_GREEN=0
  while true; do
    local elapsed=$((SECONDS - START)) snapshot state status checks verdict
    snapshot=$(pr_json); require_snapshot "$snapshot"
    state=$(echo "$snapshot" | jq -r .state); status=$(echo "$snapshot" | jq -r .mergeStateStatus)
    if is_behind "$state" "$status"; then behind_notice; exit "$EXIT_BEHIND"; fi
    if (( elapsed >= TIMEOUT )); then echo 'undetermined, re-run to resume' >&2; exit "$EXIT_DEADLINE"; fi
    [[ "$state" != MERGED ]] || { echo merged; exit 0; }
    [[ "$state" != CLOSED ]] || { echo closed; exit "$EXIT_UNMERGED"; }
    checks=$(checks_of "$snapshot"); verdict=$(echo "$checks" | classify_checks)
    case "$verdict" in
      FAIL) echo "$checks" | print_offending FAIL; dump_failed_logs "$(echo "$snapshot" | jq -r .headRefOid)" || echo 'failed-run logs unavailable' >&2; exit "$EXIT_FAIL" ;;
      CANCEL) echo "$checks" | print_offending CANCEL; exit "$EXIT_CANCELLED" ;;
      OTHER) echo "$checks" | print_offending OTHER; exit "$EXIT_OTHER" ;;
      PENDING) CONFIRMED_GREEN=0; sleep "$INTERVAL" ;;
      GREEN) (( CONFIRMED_GREEN++ )) && return || sleep "$INTERVAL" ;;
      *) echo "unexpected verdict: $verdict" >&2; exit "$EXIT_INTERNAL" ;;
    esac
  done
}
watch_merge() {
  local kit_ci=off; [[ "$MERGE_MODE" == merge-on-green ]] && kit_ci=pending
  while true; do
    local elapsed=$((SECONDS - START)) snapshot state status eligible code head_sha
    snapshot=$(pr_json); require_snapshot "$snapshot"
    state=$(echo "$snapshot" | jq -r .state); status=$(echo "$snapshot" | jq -r .mergeStateStatus)
    eligible=false
    if [[ "$state" == OPEN ]] && ! is_behind "$state" "$status" && (( elapsed < TIMEOUT )); then
      eligible=$(eligible_of "$MERGE_MODE" "$snapshot")
    fi
    code=$(classify_merge_state "$state" "$status" "$MERGE_MODE" "$eligible" "$elapsed" "$TIMEOUT")
    if [[ "$code" == WATCH && "$kit_ci" == pending ]]; then
      head_sha=$(echo "$snapshot" | jq -r .headRefOid); kit_ci=$(kit_ci_of "$head_sha")
      if [[ "$kit_ci" == unconfigured ]]; then
        if [[ -n "$SINCE" ]]; then echo 'evaluate-only: kit-ci App not configured — manual merge required (docs/kit/ci-app-setup.md)' >&2; else echo 'evaluate-only: the latest merge-on-green run was evaluate-only — configure kit-ci (docs/kit/ci-app-setup.md), then authorize the current head' >&2; fi
        exit "$EXIT_EVALUATE_ONLY"
      fi
    fi
    [[ "$code" == WATCH ]] && { sleep "$INTERVAL"; continue; }
    [[ "$code" != "$EXIT_DEADLINE" ]] || echo 'undetermined, re-run to resume' >&2
    [[ "$code" != "$EXIT_BEHIND" ]] || behind_notice
    exit "$code"
  done
}
