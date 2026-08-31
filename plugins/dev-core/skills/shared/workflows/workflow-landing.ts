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

/**
 * Classify script emitted into the `classify` job.
 *
 * (a) Predicate uses `.state == "closed"`, not the `.merged` field.
 *     `GET /repos/{owner}/{repo}/commits/{sha}/pulls` returns the *simple* PR
 *     representation: it carries `state` and `merge_commit_sha`, not `merged`
 *     (`merged` exists only on the full `GET /pulls/{number}` object). Measured
 *     2026-08-31: go-silex/silex-forge@265a079 → PR #13 `merged=null`;
 *     go-silex/silex-plugins@23c0dcd → PR #19 `merged=null`. The old select on
 *     `.merged` never matched, so every push was classified `naked` and the
 *     suite re-ran on every merge.
 *
 * (b) The check-run probe MUST require success on the PR head for exactly the
 *     display names (`name:` of the job, else the job id) of this workflow's
 *     jobs gated on `path == 'naked'`. Threshold = size of that set. Classify
 *     answers "has my own suite already run green on this head?", not "was some
 *     other suite green?". A predicate-only fix without this probe is a safety
 *     hole: a merged PR with a red suite job would skip that suite on the
 *     default branch (go-silex/silex-forge#15).
 */
const CLASSIFY_PUSH_SCRIPT = (suiteChecks: string[]): string => {
  const nameSelect = suiteChecks.map((n) => `. == "${n}"`).join(' or ')
  const threshold = suiteChecks.length
  return `set -euo pipefail
path=naked
n=0
prs="[]"
for i in 1 2 3 4 5; do
  prs="$(gh api "repos/\${REPO}/commits/\${SHA}/pulls")"
  n="$(printf '%s' "$prs" | jq --arg sha "$SHA" '[.[] | select(.state == "closed" and .merge_commit_sha == $sha)] | length')"
  if [ "$n" -gt 0 ]; then
    break
  fi
  if [ "$i" -lt 5 ]; then
    sleep 4
  fi
done
if [ "$n" -gt 0 ]; then
  head="$(printf '%s' "$prs" | jq -r --arg sha "$SHA" '[.[] | select(.state == "closed" and .merge_commit_sha == $sha)][0].head.sha')"
  ok="$(gh api --paginate "repos/\${REPO}/commits/\${head}/check-runs" --jq '[.check_runs[] | select(.conclusion == "success") | (.name | ascii_downcase) | select(${nameSelect})] | unique | length')"
  if [ "$ok" -ge ${threshold} ]; then
    path=pr-merge
  fi
fi
echo "path=\${path}" >> "$GITHUB_OUTPUT"
echo "landing path: \${path}"`
}

/** Classify job — runs on `push` only. Downstream jobs `needs: classify`. */
export function generateClassifyPushJob(suiteChecks: string[]): string {
  if (suiteChecks.length === 0) {
    throw new Error(
      'generateClassifyPushJob: suiteChecks must not be empty — empty probe would classify pr-merge unconditionally',
    )
  }
  const names: string[] = []
  for (const n of suiteChecks) {
    const lower = n.toLowerCase()
    if (!names.includes(lower)) names.push(lower)
  }
  const script = CLASSIFY_PUSH_SCRIPT(names)
    .split('\n')
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
