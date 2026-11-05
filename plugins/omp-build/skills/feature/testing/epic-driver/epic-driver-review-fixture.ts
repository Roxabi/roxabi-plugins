import { decodeHistory } from '../../../../contracts.ts'
import { actionInputDigest, canonicalValueDigest } from '../../../../engine/action-input.ts'
import type { CanonicalRecord } from '../../../../engine/record-schema.ts'
import { recordsOf } from '../../../../engine/workflow-control.ts'
import { committedFixtureProjection, committedFixtureRecords } from '../../../../testing/committed-plugin-fixture.ts'
import { criterionImplementationRecords } from '../../../../testing/criterion-accepted-plan.ts'
import { criterionSatisfiedRow, encodeCriterionRecords } from '../../../../testing/criterion-approval.ts'
import { criterionDispositionRecords } from '../../../../testing/criterion-dispositions.ts'
import { submission } from '../../../../testing/record-builders.ts'
import { contribution } from '../../../../testing/record-decisions.ts'
import { reviewGraph } from '../../../../testing/record-graphs.ts'
import { issueComments, ME, pullReviewInputs, recordHistory, serveComments } from './epic-driver-records.ts'
import { git } from './epic-driver-sandbox.ts'

/** Install a genuine accepted-C1 implementation record on the child UW. */
export function installReviewEvidence(head: string) {
  const origin = decodeHistory(recordHistory(2, issueComments(2)))
  const parent = decodeHistory(recordHistory(1, issueComments(1)))
  const mandate = recordsOf(origin).find((record) => record.kind === 'mandate')
  if (mandate?.kind !== 'mandate') throw new Error('Expected child mandate')
  const issueRecords = committedFixtureRecords(
    import.meta.dirname,
    criterionImplementationRecords(mandate, head),
    git(import.meta.dirname, 'rev-parse', 'HEAD'),
  )
  const receipt = issueRecords.find((record) => record.kind === 'action-receipt')
  if (receipt?.kind !== 'action-receipt') throw new Error('Expected fixture action receipt')
  const projection = committedFixtureProjection(import.meta.dirname, receipt.payload.inputs)
  const persisted = encodeCriterionRecords(issueRecords, origin.source.scope, projection, ME, [parent], origin)
  serveComments(2, [...issueComments(2), ...persisted.comments.map(({ body }) => ({ body, author: ME }))])
  return { mandate, issueRecords }
}

/** Publish a review graph and its actual D14 dispositions on the accepted child UW. */
export function appendBoundReview(options: {
  number: number
  head: string
  prefix: string
  blocking: boolean
  author: string
  mandate: Extract<CanonicalRecord, { kind: 'mandate' }>
  issueRecords: readonly CanonicalRecord[]
}): void {
  const { number, head, prefix, blocking, author, mandate, issueRecords } = options
  const scope = { repository: 'o/r', target: `o/r#${number}` }
  const issueHistory = decodeHistory(recordHistory(2, issueComments(2)))
  // Build each forged review against a clean operator-owned snapshot. Foreign
  // comments remain in the served PR history, but are not publication authority.
  const priorComments = issueComments(number)
  const ownedComments = priorComments.filter((comment) => comment.author === ME)
  const pullHistory = decodeHistory(recordHistory(number, ownedComments))
  const implementation = issueRecords.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
  )
  if (
    implementation?.kind !== 'action-receipt' ||
    implementation.payload.action !== 'implement' ||
    implementation.payload.phase !== 'result' ||
    implementation.payload.structured === null
  )
    throw new Error('Expected implementation result')
  const declaration = implementation.payload.structured.criteria[0]
  if (!declaration) throw new Error('Expected criterion declaration')
  const base = pullReviewInputs(number, head)
  const selection = {
    source: 'record' as const,
    role: 'implementation' as const,
    record: { scope: issueHistory.source.scope, kind: 'action-receipt' as const, recordId: implementation.recordId },
    selector: '/payload/structured/criteria/0',
    digest: canonicalValueDigest(declaration),
  }
  const manifest = { ...base.manifest, deliveryData: [selection] }
  const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
  const reviewProjection = committedFixtureProjection(import.meta.dirname, inputs)
  const graph = reviewGraph({ prefix, scope, head, inputs, empty: !blocking })
  const root = {
    ...graph.root,
    payload: {
      ...graph.root.payload,
      slots: graph.root.payload.slots.map((slot) =>
        slot.slotId === 'spec-0' ? { ...slot, role: 'R-review-spec' } : slot,
      ),
    },
  }
  const row = criterionSatisfiedRow({ mandate, inputs, head, issueRecords })
  const specStructured = { findings: [], specRows: [row] }
  const spec = contribution({
    id: graph.spec.recordId,
    scope,
    inventoryId: graph.root.recordId,
    phase: 'spec',
    role: 'R-review-spec',
    slotId: 'spec-0',
    chunk: null,
    findings: [],
    structured: specStructured,
    rawAttempts: [
      submission({ id: `child-${graph.spec.recordId}`, structuredOutput: { status: 'valid', data: specStructured } }),
    ],
  })
  if (graph.decision.payload.judgment.purpose !== 'review') throw new Error('Expected review judgment')
  const { role: _role, ...citation } = selection
  const supported = (value: boolean) => ({
    state: 'supported' as const,
    value,
    reason: 'The selected implementation record establishes this judgment',
    references: [citation],
  })
  const judgment = {
    ...graph.decision.payload.judgment,
    criterionVerdicts: [{ contributionId: spec.recordId, target: row.target }],
    causes: graph.decision.payload.judgment.causes.map((cause) => ({
      ...cause,
      judgment: { necessary: supported(true), urgent: supported(true), tooLarge: supported(false) },
      proposedDisposition: 'fix-original' as const,
    })),
  }
  const decision = { ...graph.decision, payload: { ...graph.decision.payload, judgment } }
  const synthesis = contribution({
    id: graph.synthesisContribution.recordId,
    scope,
    inventoryId: graph.synthesis.recordId,
    phase: 'synthesis',
    role: 'R-synthesis',
    slotId: 'synthesis-0',
    chunk: null,
    content: 'decision',
    structured: judgment,
    rawAttempts: [
      submission({
        id: `child-${graph.synthesisContribution.recordId}`,
        structuredOutput: { status: 'valid', data: judgment },
      }),
    ],
  })
  const before = encodeCriterionRecords(
    [root, spec, graph.panel, graph.synthesis, synthesis, decision],
    scope,
    reviewProjection,
    ME,
    [issueHistory],
    pullHistory,
  )
  const decisionRecord = recordsOf(before.history).find(
    (record) => record.kind === 'decision' && record.recordId === decision.recordId,
  )
  if (decisionRecord?.kind !== 'decision') throw new Error('Review decision was not authenticated')
  const { original, dispositions } = criterionDispositionRecords(
    inputs,
    decisionRecord,
    [issueHistory, before.history],
    reviewProjection.catalogues,
  )
  const persisted = encodeCriterionRecords(dispositions, original, reviewProjection, ME, [before.history], issueHistory)
  const refs = dispositions.map((record) => ({
    scope: original,
    kind: 'cause-disposition' as const,
    recordId: record.recordId,
  }))
  const review = { ...graph.review, payload: { ...graph.review.payload, causeDispositionRefs: refs } }
  const final = encodeCriterionRecords([review], scope, reviewProjection, ME, [persisted.history], before.history)
  if (author === ME)
    serveComments(2, [...issueComments(2), ...persisted.comments.map(({ body }) => ({ body, author: ME }))])
  serveComments(number, [
    ...issueComments(number),
    ...before.comments.map(({ body }) => ({ body, author })),
    ...final.comments.map(({ body }) => ({ body, author })),
  ])
}
