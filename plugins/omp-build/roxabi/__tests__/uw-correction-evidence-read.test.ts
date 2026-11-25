import { expect, test } from 'vitest'
import { actionInputDigest, canonicalValueDigest } from '../../engine/action-input.ts'
import type { DeliveryDataRef } from '../../engine/action-input-schema.ts'
import { assessHistoricalCauseDispositions } from '../../engine/cause-assessment.ts'
import { decisionCauseCapture } from '../../engine/cause-capture-authentication.ts'
import { resolveAdmittedCorrectionCriterionSource } from '../../engine/correction-criterion-source.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { ReviewClassCatalogues } from '../../engine/review-class-catalogue.ts'
import type { SpecEffective } from '../../engine/spec-effective-schema.ts'
import { assessUwCompletion } from '../../engine/uw-completion.ts'
import type { UwCompletionObservation } from '../../engine/uw-completion-types.ts'
import { projectUwDelivery } from '../../engine/uw-delivery-projection.ts'
import { recordRef } from '../../engine/uw-delivery-review.ts'
import { recordsOf } from '../../engine/workflow-control.ts'
import { acceptedActionInputs, fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import { criterionReviewGraph } from '../../testing/criterion-approval.ts'
import { graphFromSimulatedIssues } from '../../testing/criterion-dispositions.ts'
import { roxabiRecordFixtures } from '../../testing/roxabi-presets.ts'
import { executeDurableUwCommand } from '../uw-command-read.ts'
import { historicalCorrectionProof } from './uw-historical-correction-proof-fixture.ts'
import { correctionProofHistory } from './uw-historical-correction-proof-fixture-data.ts'

type Case = 'admitted' | 'missing lineage' | 'unknown producer proof'

function issueWithAuthenticatedDisposition(
  issue: DecodedHistory,
  review: DecodedHistory,
  context: DecodedHistory,
  effective: SpecEffective,
  catalogues: ReviewClassCatalogues,
) {
  const issueRecords = recordsOf(issue)
  const disposition = issueRecords.find((record) => record.kind === 'cause-disposition')
  const decision = recordsOf(review).find((record) => record.kind === 'decision')
  if (disposition === undefined || decision === undefined || disposition.payload.subject.kind !== 'cause')
    throw new Error('Expected a captured correction decision and its disposition')
  const { cause } = disposition.payload.subject
  const histories = [review, issue, context]
  const capture = decisionCauseCapture(decision, histories)
  if (!capture.ok) throw new Error(`Expected captured correction synthesis: ${JSON.stringify(capture.diagnostics)}`)
  const assessed = assessHistoricalCauseDispositions({
    context: { original: effective.own.uw, effective },
    capture: capture.value,
    source: { kind: 'decision', decision },
    histories,
    catalogues,
    adjudications: [],
  })
  if (!assessed.ok) throw new Error(`Expected correction disposition: ${JSON.stringify(assessed.diagnostics)}`)
  const payload = assessed.value.outcomes.find(
    (item) => item.subject.kind === 'cause' && item.subject.cause.id === cause.id,
  )
  if (payload === undefined) throw new Error(`Expected a disposition for ${cause.id}`)
  return correctionProofHistory(
    issue.source.scope,
    issueRecords.map((record) => (record === disposition ? { ...disposition, payload } : record)),
  )
}

const unobservedCorrection = {
  source: 'git-file' as const,
  repository: 'acme/widgets',
  commit: 'c'.repeat(40),
  path: 'region.test.ts',
  digest: '0'.repeat(64),
}

function pin(
  record: CanonicalRecord,
  role: DeliveryDataRef['role'],
  selector: string,
  value: unknown,
): DeliveryDataRef {
  return { source: 'record', record: recordRef(record), role, selector, digest: canonicalValueDigest(value) }
}

function correctedEvidenceWorld(variant: Case) {
  const proof = historicalCorrectionProof(undefined, variant === 'unknown producer proof' ? [unobservedCorrection] : [])
  const { mandate, binding, result, head, planActionId, spec, contextHistory, request } = proof
  const uw = spec.effective.own.uw
  const pullRequest = proof.review.source.scope
  const { projection } = roxabiRecordFixtures()
  const issue = issueWithAuthenticatedDisposition(
    proof.issue,
    proof.review,
    contextHistory,
    spec.effective,
    projection.catalogues,
  )
  const admitted = resolveAdmittedCorrectionCriterionSource(
    result,
    [proof.review, issue, contextHistory],
    { head, planActionId, mandate: recordRef(mandate), ownSpec: spec.effective.own },
    projection.catalogues,
  )
  if (!admitted.ok || admitted.value === null)
    throw new Error(`Expected authentic correction: ${JSON.stringify(admitted)}`)
  const declaration = result.payload.criterionReceipt?.criteria[0]
  if (!declaration) throw new Error('Expected a captured correction declaration')
  const { role: _role, ...receipt } = pin(result, 'implementation', '/payload/criterionReceipt/criteria/0', declaration)
  const base = acceptedActionInputs(mandate, 'review', spec.effective, request.code)
  const manifest = {
    ...base.manifest,
    subject: request.subject,
    deliveryData: [
      { ...receipt, role: 'implementation' as const },
      ...admitted.value.lineage
        .filter((item) => variant !== 'missing lineage' || item.recordId !== proof.source.recordId)
        .map((item) => pin(item, 'correction-lineage', '/payload', item.payload)),
    ],
  }
  const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
  const graph = graphFromSimulatedIssues(uw, [
    {
      number: 7,
      title: 'Preserve the selected region',
      body: mandate.payload.ownSpec.snapshot.raw.body,
      updatedAt: '2026-10-27T12:00:00.000Z',
      labels: [`size:${mandate.payload.tier}`],
      state: 'OPEN',
      subIssues: [],
      blockedBy: [],
    },
  ])
  const review = criterionReviewGraph({
    mandate,
    inputs,
    head,
    issueRecords: [result],
    issueHistory: issue,
    scope: pullRequest,
    pullHistory: proof.review,
    projection,
    graph,
    prefix: 'corrected-delivery',
    verdict: 'Request changes',
    retainedFinal: variant === 'unknown producer proof',
    adjustCriterion: (row) =>
      variant === 'missing lineage'
        ? { ...row, verdict: 'unverified', examined: [], reason: 'Correction lineage is not proven' }
        : row,
    contextHistories: [contextHistory],
  })
  const observation: UwCompletionObservation = {
    status: 'complete',
    root: uw,
    graph,
    histories: [review.history, review.issueHistory, contextHistory],
    catalogues: projection.catalogues,
    delivery: [
      {
        uw,
        pullRequests: [
          {
            pullRequest,
            branch: binding.payload.branch,
            base: binding.payload.base,
            head,
            baseTip: request.code.base,
            state: 'OPEN',
            mergeCommit: null,
          },
        ],
        commits: [],
        integrations: [],
      },
    ],
  }
  return { observation, uw, receipt, declaration, head }
}

test.each(['admitted', 'missing lineage', 'unknown producer proof'] as const)(
  '/uw evidence distinguishes correction lineage from producer proof: %s',
  async (variant) => {
    const { observation, uw, receipt, declaration, head } = correctedEvidenceWorld(variant)
    const projected = projectUwDelivery(observation, assessUwCompletion(observation), uw)
    if (!projected.ok) throw new Error('Expected read-only correction projection')
    const result = await executeDurableUwCommand(
      { kind: 'evidence', repository: uw.repository, number: 7 },
      { ...fixtureUwOperations(), readDelivery: async () => projected },
    )
    const lacksLineage = expect.objectContaining({
      code: 'mismatch',
      message: `Correction delivery ${receipt.record.recordId} lacks its authenticated lineage pins`,
    })
    const deniedObservation = expect.objectContaining({
      code: 'unknown-reference',
      message: 'Evidence region-proof cites an unauthenticated pinned source',
    })
    const expectedDeclaration = { receipt, value: declaration, code: { repository: uw.repository, commit: head } }
    expect(result.value).toMatchObject({ status: 'evidence', uw })
    if (variant === 'missing lineage') expect(result.value).toMatchObject({ declarations: [] })
    if (variant === 'admitted') expect(result.value).toMatchObject({ declarations: [expectedDeclaration] })
    if (variant === 'missing lineage')
      expect(result.value).toMatchObject({ diagnostics: expect.arrayContaining([lacksLineage]) })
    else expect(projected.value.diagnostics).not.toContainEqual(lacksLineage)
    if (variant === 'unknown producer proof') expect(projected.value.diagnostics).toContainEqual(deniedObservation)
    else expect(projected.value.diagnostics).not.toContainEqual(deniedObservation)
    expect(projected.value.verdicts.map(({ value }) => value.verdict)).toEqual(
      variant === 'unknown producer proof' ? [] : [variant === 'admitted' ? 'satisfied' : 'unverified'],
    )
  },
)
