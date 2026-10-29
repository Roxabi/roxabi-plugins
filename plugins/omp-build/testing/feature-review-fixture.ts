import path from 'node:path'

import { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { specDigest } from '../engine/record-digests.ts'
import type { Scope } from '../engine/record-values.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../engine/uw-spec-schema.ts'
import { criterionImplementationRecords } from './criterion-accepted-plan.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { git, sandbox, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

export const REVIEW_SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
export const REVIEW_BRANCH = 'feat/42-save'

export function nativeFeatureSpec(scope: Scope, criterion: string) {
  const canonical = canonicalSpec({
    format: SPEC_CONTENT_FORMAT,
    criteria: [{ id: 'C1', statement: criterion }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error(canonical.diagnostics.map((item) => item.code).join(','))
  const body = renderIssueSpecBody(canonical.value)
  return {
    body,
    ownSpec: roxabiWorkflowFixtures().ownSpecFromSnapshot(scope, {
      spec: canonical.value,
      raw: { reference: scope.target, body, bodySha256: specDigest(body), lastEditedAt: '2026-10-21T12:00:00Z' },
    }),
  }
}

const REVIEW_TIER = 'F-lite' as const
const REVIEW_SPEC = nativeFeatureSpec(REVIEW_SCOPE, 'preserves the region')
export const REVIEW_BODY = REVIEW_SPEC.body
const { featureMandate, framedBodies, historyFrom, workflowBinding } = roxabiWorkflowFixtures()

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
    issues: [{ number: 42, title: 'feat: preserve region', labels: [`size:${REVIEW_TIER}`] }],
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
    ownSpec: REVIEW_SPEC.ownSpec,
    lineageHead: head,
    tier: REVIEW_TIER,
  })
  const records = criterionImplementationRecords(mandate, head)
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
