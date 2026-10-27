import { rmSync } from 'node:fs'
import path from 'node:path'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { nativeFeatureSpec } from './feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { git, sandbox, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

export const SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
export const BRANCH = 'feat/42-save'
export const OBSERVED_INCOMPLETE_NATIVE_TERMINAL = {
  index: 0,
  id: 'R-workflow-implement',
  agent: 'R-workflow-implement',
  exitCode: 1,
  structuredOutput: { status: 'invalid', data: { refusal: 'incomplete-native' } },
}

const FEATURE_SPEC = nativeFeatureSpec(SCOPE, 'preserves the region')
const BODY = FEATURE_SPEC.body
const {
  clearPlanContribution,
  featureMandate,
  framedBodies,
  implementStart,
  planDraftRecords,
  planReviewRecord,
  planReviewStart,
  publishedPlanDigest,
  rejectedImplementResult,
} = roxabiWorkflowFixtures()

let roots: string[] = []

export function cleanupFeatureRecoveryRoots(): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
}

export function trackFeatureRecoveryRoot(root: string): void {
  roots.push(root)
}

export function featureFixture(
  records: 'plan' | 'start' | 'confirmed-implementation',
  options: { malformedDisarmPr?: boolean } = {},
): { box: Box; checkout: string } {
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
    branches: [
      {
        name: BRANCH,
        from: 'main',
        commits:
          records === 'confirmed-implementation'
            ? [{ message: 'feat: preserve region', files: { 'src/save.ts': 'export const save = true\n' } }]
            : [],
      },
    ],
    issues: [{ number: 42, title: 'feat: preserve region', labels: ['size:S'] }],
    prs: options.malformedDisarmPr
      ? [{ number: 9, branch: BRANCH, title: 'unreadable pause gate', body: '', closes: [] }]
      : [],
  })
  trackFeatureRecoveryRoot(box.root)
  const checkout = path.join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', checkout, BRANCH])
  const mandate = featureMandate(SCOPE, {
    branch: BRANCH,
    body: BODY,
    ownSpec: FEATURE_SPEC.ownSpec,
    lineageHead: box.sha.main,
  })
  const accepted =
    records === 'plan'
      ? [
          mandate,
          ...planDraftRecords(mandate),
          planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
          planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
            clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
            clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
          ]),
        ]
      : records === 'start'
        ? [mandate, implementStart(mandate)]
        : confirmedImplementationRecords(mandate, box)
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('missing feature issue')
    issue.body = BODY
    issue.comments.push(...framedBodies(accepted, 'operator').map((body) => ({ author: 'operator', body })))
  })
  if (options.malformedDisarmPr) {
    writeSim(box, (state) => {
      const pull = state.prs['9']
      if (!pull) throw new Error('missing disarm pull request')
      Object.assign(pull, { labels: [1] })
    })
  }
  return { box, checkout }
}

function confirmedImplementationRecords(mandate: MandateRecord, box: Box) {
  const head = box.sha[BRANCH]
  if (head === undefined) throw new Error('confirmed implementation fixture missing branch head')
  const rejected = rejectedImplementResult(mandate)
  if (
    rejected.kind !== 'action-receipt' ||
    rejected.payload.action !== 'implement' ||
    rejected.payload.phase !== 'result' ||
    rejected.payload.structured === null ||
    rejected.payload.admission === null
  ) {
    throw new Error('confirmed implementation fixture missing payload')
  }
  return [
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
        admission: {
          ...rejected.payload.admission,
          admitted: true,
          commits: [head],
          remoteBranch: BRANCH,
          remoteTip: head,
          reason: 'admitted',
        },
      },
    },
  ]
}
