import { type CanonicalRecord, encodeRecord } from '../dist/contracts.js'
import { validateActionInputs } from '../engine/action-input.ts'
import { TEST_REVIEW_INPUT } from '../testing/record-builders.ts'
import { contribution } from '../testing/record-decisions.ts'
import { reviewGraph } from '../testing/record-graphs.ts'
import { roxabiRecordFixtures } from '../testing/roxabi-presets.ts'
export const RECEIPT = 'receipt-1'
export const TARGET = {
  repository: 'Acme/app',
  target: 'Acme/app#42',
  number: 42,
  kind: 'pull-request' as const,
  state: 'open' as const,
  candidateGitSHA: 'a'.repeat(40),
}
export const { projection: TEST_PROJECTION_CONFIG } = roxabiRecordFixtures()

export type ReviewJudgment = Extract<
  Extract<CanonicalRecord, { kind: 'decision' }>['payload']['judgment'],
  { purpose: 'review' }
>
type ReviewAttemptRecord = Extract<CanonicalRecord, { kind: 'review-attempt' }>

function boundInventory(record: CanonicalRecord): CanonicalRecord {
  if (record.kind !== 'review-attempt' || !('inputSnapshot' in record.payload)) return record
  const validated = validateActionInputs(record.payload.inputSnapshot)
  if (!validated.ok) return record
  const digest = validated.value.fingerprint
  return {
    ...record,
    payload: {
      ...record.payload,
      actionInputDigest: digest,
      input: record.payload.input === null ? null : digest,
      inputSnapshot: validated.value,
    },
  }
}

export function canonicalUnusableComments(): string[] {
  const graph = reviewGraph({ prefix: 'debt', head: TARGET.candidateGitSHA })
  const sourceJudgment = graph.decision.payload.judgment
  const judgment: Extract<CanonicalRecord, { kind: 'decision' }>['payload']['judgment'] = {
    purpose: 'correction',
    policy: sourceJudgment.policy,
    sourceContributionIds: ['debt-spec', 'debt-panel'],
    findings: [
      {
        id: 'finding-1',
        label: 'issue',
        impactReason: 'The saved region is wrong.',
        state: 'unusable',
        sourceFindingIds: ['debt-panel:f0'],
      },
    ],
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
  const decision: CanonicalRecord = {
    ...graph.decision,
    recordId: 'decision-1',
    operationId: 'operation-decision-1',
    inputs: ['debt-decision-source', 'debt-spec', 'debt-panel'],
    repository: TARGET.repository,
    target: TARGET.target,
    payload: { originalContributionId: 'debt-decision-source', judgment },
  }
  const synthesis: CanonicalRecord = {
    ...graph.synthesisContribution,
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      ...graph.synthesisContribution.payload,
      structured: judgment,
      rawAttempts: graph.synthesisContribution.payload.rawAttempts.map((attempt) => ({ ...attempt, data: judgment })),
    },
  }
  const requestContribution: CanonicalRecord = {
    ...contribution({ id: 'fix-request-contribution', inventoryId: null, content: 'operator-request' }),
    repository: TARGET.repository,
    target: TARGET.target,
  }
  const request: CanonicalRecord = {
    version: 1,
    recordId: 'fix-request-1',
    runId: 'run-2026-10-21',
    operationId: 'operation-fix-request-1',
    inputs: [requestContribution.recordId],
    kind: 'fix-request',
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      requestContributionId: requestContribution.recordId,
      existingReviewId: null,
      scope: TARGET.target,
      landing: false,
    },
  }
  const root: ReviewAttemptRecord = {
    version: 1,
    recordId: 'debt-root',
    runId: 'run-2026-10-21',
    operationId: 'op-debt-root',
    inputs: [request.recordId],
    kind: 'review-attempt',
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      rootAttemptId: 'debt-root',
      candidateGitSHA: TARGET.candidateGitSHA,
      inputFormat: 'omp-build:review-input/4',
      input: TEST_REVIEW_INPUT,
      actionInputDigest: TEST_REVIEW_INPUT,
      slots: graph.root.payload.slots,
      stage: 'initial',
      purpose: 'correction',
      requestId: request.recordId,
      policy: sourceJudgment.policy,
    },
  }
  const correctionSynthesis: ReviewAttemptRecord = {
    version: 1,
    recordId: 'debt-synthesis',
    runId: 'run-2026-10-21',
    operationId: 'op-debt-synthesis',
    inputs: [root.recordId],
    kind: 'review-attempt',
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      rootAttemptId: root.recordId,
      candidateGitSHA: TARGET.candidateGitSHA,
      inputFormat: 'omp-build:review-input/4',
      input: TEST_REVIEW_INPUT,
      actionInputDigest: TEST_REVIEW_INPUT,
      slots: graph.synthesis.payload.slots,
      stage: 'synthesis',
      purpose: 'correction',
      policy: sourceJudgment.policy,
    },
  }
  const records: CanonicalRecord[] = [
    requestContribution,
    request,
    root,
    { ...graph.spec, repository: TARGET.repository, target: TARGET.target },
    { ...graph.panel, repository: TARGET.repository, target: TARGET.target },
    correctionSynthesis,
    synthesis,
    decision,
  ]
  return encodeCanonicalComments(records)
}

export function encodeCanonicalComments(records: readonly CanonicalRecord[]): string[] {
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
    const encoded = encodeRecord(boundInventory(record), history(bodies), TEST_PROJECTION_CONFIG)
    if (!encoded.ok) throw new Error(encoded.diagnostics.map((item) => item.code).join(','))
    bodies.push(...encoded.value)
  }
  return bodies
}
