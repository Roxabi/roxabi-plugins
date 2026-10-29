import { type CanonicalRecord, encodeRecord } from '../dist/contracts.js'
import { contribution } from '../testing/record-decisions.ts'
import { reviewGraph } from '../testing/record-graphs.ts'
import {
  canonicalUnusableComments,
  type ReviewJudgment,
  TARGET,
  TEST_PROJECTION_CONFIG,
} from './debt-filing.fixture-records.ts'

export function canonicalComments(options: { unusable?: boolean } = {}): string[] {
  if (options.unusable) return canonicalUnusableComments()
  const graph = reviewGraph({
    prefix: 'debt',
    head: TARGET.candidateGitSHA,
    scope: { repository: TARGET.repository, target: TARGET.target },
  })
  const sourceJudgment = graph.decision.payload.judgment
  if (sourceJudgment.purpose !== 'review') throw new Error('review-fixture-purpose-missing')
  const findings: ReviewJudgment['findings'] = options.unusable
    ? [
        {
          id: 'finding-1',
          label: 'issue',
          impactReason: 'The saved region is wrong.',
          state: 'unusable',
          sourceFindingIds: ['debt-panel:f0'] as [string],
        },
      ]
    : [
        {
          id: 'finding-1',
          label: 'issue',
          impactReason: 'The saved region is wrong.',
          state: 'usable',
          sourceFindingIds: ['debt-panel:f0'],
          description: 'Save the selected region rather than the stale region.',
        },
      ]
  const judgment: ReviewJudgment = {
    ...sourceJudgment,
    findings,
    causes: [
      {
        id: 'cause-1',
        title: 'Persist the selected region',
        mechanism: 'The save path uses the stale region field.',
        fix: 'Save the selected region field.',
        failure: 'Saving eu-west persists us-east.',
        restored: 'Saving preserves the selected region.',
        paths: ['src/widget.ts'],
        proof: 'pnpm test widget',
        findingIds: ['finding-1'],
      },
    ],
  }
  const decision = {
    ...graph.decision,
    recordId: 'decision-1',
    operationId: 'operation-decision-1',
    inputs: ['debt-decision-source', 'debt-spec', 'debt-panel'],
    payload: {
      ...graph.decision.payload,
      originalContributionId: 'debt-decision-source',
      judgment,
    },
  } satisfies CanonicalRecord
  const synthesis = {
    ...graph.synthesisContribution,
    payload: {
      ...graph.synthesisContribution.payload,
      structured: decision.payload.judgment,
      rawAttempts: graph.synthesisContribution.payload.rawAttempts.map((attempt) => ({
        ...attempt,
        data: decision.payload.judgment,
      })),
    },
  } satisfies CanonicalRecord
  const review = {
    ...graph.review,
    inputs: graph.review.inputs.map((id) => (id === graph.decision.recordId ? decision.recordId : id)),
    payload: { ...graph.review.payload, decisionId: decision.recordId },
  } satisfies CanonicalRecord
  const requestContribution = contribution({
    id: 'fix-request-contribution',
    inventoryId: null,
    content: 'operator-request',
  })
  const request: CanonicalRecord = {
    version: 1,
    recordId: 'fix-request-1',
    runId: 'run-2026-10-21',
    operationId: 'operation-fix-request-1',
    inputs: [requestContribution.recordId, review.recordId],
    kind: 'fix-request',
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      requestContributionId: requestContribution.recordId,
      existingReviewId: review.recordId,
      scope: TARGET.target,
      landing: false,
    },
  }
  const records = graph.records
    .map((record) =>
      record.recordId === graph.decision.recordId
        ? decision
        : record.recordId === graph.synthesisContribution.recordId
          ? synthesis
          : record.recordId === graph.review.recordId
            ? review
            : record,
    )
    .concat(requestContribution, request)
    .map((record) => ({ ...record, repository: TARGET.repository, target: TARGET.target }))
  const history = (comments: readonly string[]) => ({
    scope: { repository: TARGET.repository, target: TARGET.target },
    expectedAuthor: 'native-bot',
    stopAuthor: null,
    complete: true,
    comments: comments.map((body, index) => ({
      locator: `comment-${index + 1}`,
      nativeId: String(index + 1),
      body,
      author: 'native-bot',
      createdAt: '2026-10-21T10:00:00Z',
      updatedAt: '2026-10-21T10:00:00Z',
    })),
    diagnostics: [],
  })
  const bodies: string[] = []
  for (const record of records) {
    const encoded = encodeRecord(record, history(bodies), TEST_PROJECTION_CONFIG)
    if (!encoded.ok) throw new Error(encoded.diagnostics.map((item) => item.code).join(','))
    bodies.push(...encoded.value)
  }
  return bodies
}

export function withUnknownSourceFinding(bodies: readonly string[]): string[] {
  return bodies.map((body) => {
    if (!body.includes('id=decision-1 ')) return body
    return body.replace(
      /^(<!-- omp-build-record v=1 kind=decision id=decision-1 operationId=operation-decision-1 part=1\/1 data=)([^ ]+)( -->)/,
      (_, prefix: string, encoded: string, suffix: string) => {
        const record = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CanonicalRecord
        if (record.kind !== 'decision') throw new Error('decision-fixture-missing')
        const first = record.payload.judgment.findings[0]
        if (first === undefined) throw new Error('decision-fixture-finding-missing')
        first.sourceFindingIds = ['missing-source:f0']
        return `${prefix}${Buffer.from(JSON.stringify(record)).toString('base64url')}${suffix}`
      },
    )
  })
}
