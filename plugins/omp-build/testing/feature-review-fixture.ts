import path from 'node:path'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { git, sandbox, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

export const REVIEW_SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
export const REVIEW_BRANCH = 'feat/42-save'
export const REVIEW_BODY = '## Acceptance criteria\n\n- [ ] preserves the region\n'
const {
  clearPlanContribution,
  featureMandate,
  framedBodies,
  historyFrom,
  implementStart,
  planDraftRecords,
  planReviewRecord,
  planReviewStart,
  publishedPlanDigest,
  workflowBinding,
} = roxabiWorkflowFixtures()

export function arrangeReviewFixture(): { box: Box; cwd: string } {
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
    branches: [
      {
        name: REVIEW_BRANCH,
        from: 'main',
        commits: [{ message: 'feat: preserve region', files: { 'src/save.ts': 'export const save = true\n' } }],
      },
    ],
    issues: [{ number: 42, title: 'feat: preserve region' }],
    prs: [{ number: 7, branch: REVIEW_BRANCH, title: 'feat: preserve region', body: 'Closes #42', closes: [42] }],
  })
  const cwd = path.join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', cwd, REVIEW_BRANCH])
  return { box, cwd }
}

export async function seedReviewFixture(box: Box, _cwd: string): Promise<void> {
  const head = box.sha[REVIEW_BRANCH]
  if (head === undefined) throw new Error('review-fixture-head-missing')
  const mandate = featureMandate(REVIEW_SCOPE, {
    branch: REVIEW_BRANCH,
    body: REVIEW_BODY,
    lineageHead: head,
  })
  const rejected = roxabiWorkflowFixtures().rejectedImplementResult(mandate)
  if (
    rejected.payload.action !== 'implement' ||
    rejected.payload.phase !== 'result' ||
    rejected.payload.structured == null ||
    rejected.payload.admission == null
  )
    throw new Error('review-fixture-implementation-invalid')
  const records = [
    mandate,
    ...planDraftRecords(mandate),
    planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
    planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ]),
    implementStart(mandate),
    {
      ...rejected,
      payload: {
        ...rejected.payload,
        structured: { ...rejected.payload.structured, commitSHAs: [head] },
        admission: { ...rejected.payload.admission, admitted: true, remoteBranch: REVIEW_BRANCH, remoteTip: head },
      },
    },
  ]
  const binding = workflowBinding({ repository: 'acme/app', target: 'acme/app#7' }, mandate, REVIEW_BRANCH, 'main')
  writeSim(box, (state) => {
    const issue = state.issues['42']
    const pull = state.prs['7']
    if (issue === undefined || pull === undefined) throw new Error('review-fixture-scope-missing')
    issue.body = REVIEW_BODY
    issue.comments.push(...framedBodies(records, 'operator').map((body) => ({ author: 'operator', body })))
    pull.comments.push(
      ...framedBodies([binding], 'operator', [historyFrom(records)]).map((body) => ({ author: 'operator', body })),
    )
  })
}
