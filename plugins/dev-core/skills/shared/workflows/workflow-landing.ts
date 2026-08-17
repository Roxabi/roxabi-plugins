/**
 * CI landing path — processed PR vs naked commit on push to main/staging.
 * SSoT: ~/projects/ssot/conventions.ssot.md § CI landing
 * Detail: ~/projects/docs/release-convention.md § CI landing
 *
 * path=pr-merge → skip the validation suite (effects still fire).
 * path=naked    → run the suite (commit never went through the PR gate).
 * Fail-closed: any error or missing signal → naked.
 */

export const CLASSIFY_JOB_ID = 'classify'

/** `if:` for a validation job that must not retest a processed PR merge. */
export function landingSuiteIf(): string {
  return [
    'always() && !cancelled()',
    "&& (github.event_name != 'pull_request' || !github.event.pull_request.draft)",
    "&& (github.event_name != 'push' || needs.classify.outputs.path == 'naked')",
  ].join(' ')
}

const CLASSIFY_PUSH_SCRIPT = `set -euo pipefail
path=naked
prs="$(gh api "repos/\${REPO}/commits/\${SHA}/pulls")"
n="$(printf '%s' "$prs" | jq --arg sha "$SHA" '[.[] | select(.merged == true and .merge_commit_sha == $sha)] | length')"
if [ "$n" -gt 0 ]; then
  head="$(printf '%s' "$prs" | jq -r --arg sha "$SHA" '[.[] | select(.merged == true and .merge_commit_sha == $sha)][0].head.sha')"
  conc="$(gh api --paginate "repos/\${REPO}/commits/\${head}/check-runs" --jq '[.check_runs[] | select((.name | ascii_downcase) == "ci") | .conclusion] | map(select(. == "success")) | if length > 0 then "success" else "missing" end')"
  if [ "$conc" = "success" ]; then
    path=pr-merge
  fi
fi
echo "path=\${path}" >> "$GITHUB_OUTPUT"
echo "landing path: \${path}"`

/** Classify job — runs on `push` only. Downstream jobs `needs: classify`. */
export function generateClassifyPushJob(): string {
  const script = CLASSIFY_PUSH_SCRIPT.split('\n')
    .map((l) => (l.length ? `          ${l}` : ''))
    .join('\n')
  return `  classify:
    name: Classify push
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    timeout-minutes: 2
    outputs:
      path: \${{ steps.out.outputs.path }}
    steps:
      - id: out
        env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
          SHA: \${{ github.sha }}
        run: |
${script}
`
}

export const LANDING_PERMISSIONS = `permissions:
  contents: read
  checks: read
  pull-requests: read
`
