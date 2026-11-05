import { describe, expect, it } from 'vitest'
import {
  actionInputDigest,
  type CanonicalRecord,
  canonicalValueDigest,
  type DecodedHistory,
  decodeHistory,
  recordsOf,
  validateCauseDispositionRecords,
} from '../dist/contracts.js'
import type { NativeChildResult } from '../omp/review-runtime/contracts.ts'
import { criterionImplementationRecords } from '../testing/criterion-accepted-plan.ts'
import { criterionReviewGraph, encodeCriterionRecords } from '../testing/criterion-approval.ts'
import { fixtureHostReviewClassCatalogues } from '../testing/host-catalogue-fixture.ts'
import { acceptedPullRequestReviewGraph } from '../testing/record-graphs.ts'
import { observedComment, operation } from '../testing/record-history.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { persistCauseDispositions } from './fix-disposition-execution.ts'
import type { FixDispositionStore } from './fix-disposition-store.ts'
import { finalizeReview } from './review-runner-finalize.ts'

const original = { repository: 'Acme/app', target: 'Acme/app#12' }
const pullRequest = { repository: 'Acme/app', target: 'Acme/app#42' }

function fixture(refuseWrite = false, validCriterion = false) {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = validCriterion
    ? fixtures.featureMandate(original, { branch: 'fix/42-save' })
    : fixtures.fixOnlyMandate(original)
  const binding = fixtures.workflowBinding(pullRequest, mandate, 'fix/42-save', 'main')
  const base = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'green-finalization', label: 'suggestion' })
  const built = (() => {
    if (!validCriterion) return { graph: base, origin: fixtures.historyFrom([mandate]) }
    const head = base.inputs.manifest.code.head
    const issueRecords = criterionImplementationRecords(mandate, head)
    const origin = fixtures.historyFrom(issueRecords)
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
      throw new Error('fixture implementation result missing')
    const declaration = implementation.payload.structured.criteria[0]
    if (!declaration) throw new Error('fixture criterion declaration missing')
    const manifest = {
      ...base.inputs.manifest,
      acceptedSources: [
        {
          source: 'record' as const,
          record: { scope: original, recordId: mandate.recordId, kind: 'mandate' as const },
          selector: '/payload',
          digest: canonicalValueDigest(mandate.payload),
        },
      ],
      deliveryData: [
        {
          source: 'record' as const,
          role: 'implementation' as const,
          record: { scope: original, recordId: implementation.recordId, kind: 'action-receipt' as const },
          selector: '/payload/structured/criteria/0',
          digest: canonicalValueDigest(declaration),
        },
      ],
    }
    const inputs = { ...base.inputs, manifest, fingerprint: actionInputDigest(manifest) }
    const criterion = criterionReviewGraph({
      mandate,
      issueRecords,
      issueHistory: origin,
      inputs,
      head,
      scope: pullRequest,
      pullHistory: fixtures.historyFrom([binding], undefined, undefined, [origin]),
      projection: roxabiRecordFixtures().projection,
      prefix: 'green-finalization',
      author: 'operator',
      verdict: 'Approve with comments',
    })
    return { graph: { ...base, ...criterion, inputs }, origin }
  })()
  const graph = built.graph
  let origin = built.origin
  const inputs = graph.inputs
  if (inputs.manifest.spec.kind !== 'accepted') throw new Error('accepted fixture required')
  const context = { original, effective: inputs.manifest.spec.effective }
  const withheld = new Set(
    graph.history.operations
      .filter((item) => item.recordId === graph.decision.recordId || item.recordId === graph.review.recordId)
      .flatMap((item) => item.parts.map((part) => part.nativeId)),
  )
  let target: DecodedHistory = validCriterion
    ? decodeHistory({
        ...graph.history.source,
        comments: graph.history.source.comments.filter((comment) => !withheld.has(comment.nativeId)),
      })
    : {
        ...graph.history,
        operations: graph.history.operations.filter(
          (item) => item.recordId !== graph.decision.recordId && item.recordId !== graph.review.recordId,
        ),
      }
  const saved: CanonicalRecord[] = []
  const identity = {
    runId: 'review-run',
    operationId: 'review-operation',
    nextRecordId: (kind: string) => `${kind}-unused`,
  }
  const store: FixDispositionStore = {
    catalogues: async () => fixtureHostReviewClassCatalogues(),
    read: async () => ({ ok: true, value: [origin, target] }),
    publish: async (record) => {
      if (refuseWrite)
        return {
          status: 'refused',
          history: origin,
          diagnostics: [{ code: 'write-unconfirmed', message: 'Native readback unavailable' }],
        }
      const diagnostics = validateCauseDispositionRecords({
        records: [...recordsOf(origin), record],
        histories: [origin, target],
        catalogues: fixtureHostReviewClassCatalogues(),
      })
      if (diagnostics.length) return { status: 'refused', history: origin, diagnostics }
      if (validCriterion) {
        const encoded = encodeCriterionRecords(
          [record],
          original,
          roxabiRecordFixtures().projection,
          origin.source.expectedAuthor,
          [target],
          origin,
        )
        origin = encoded.history
        const confirmed = origin.operations.find((item) => item.recordId === record.recordId)
        if (confirmed?.status !== 'complete' || confirmed.record === null)
          throw new Error(`disposition-readback-missing:${record.recordId}`)
        return { status: 'confirmed', operation: confirmed }
      }
      const observed = operation(record, {
        authority: 'accounted',
        parts: [observedComment({ author: origin.source.expectedAuthor })],
      })
      origin = { ...origin, operations: [...origin.operations, observed] }
      return { status: 'confirmed', operation: observed }
    },
  }
  const child: NativeChildResult = {
    id: 'synthesis-child',
    expectedId: 'synthesis',
    submissions: [],
    proofEvidence: null,
    raw: {},
    partialText: null,
    structured: graph.decision.payload.judgment,
    usable: true,
    reason: null,
  }
  const input = {
    review: {
      context: {
        subject: { kind: 'pull-request' as const },
        candidateGitSHA: inputs.manifest.code.head,
        input: graph.root.payload.input,
      },
      policy: { version: 'baseline' as const },
      canonicalClasses: [],
      authorize: async () => ({ ok: true as const }),
    },
    identity: {
      runId: identity.runId,
      operationId: identity.operationId,
      next: (kind: string) => (kind === 'decision' ? graph.decision.recordId : `${kind}-finalization`),
    },
    scope: pullRequest,
    contributions: [{ id: graph.synthesisContribution.recordId, child }],
    inventories: [graph.root.recordId, graph.synthesis.recordId],
    canContinue: () => true,
    readHistory: async () => target,
    publish: async (record: CanonicalRecord) => {
      saved.push(record)
      if (validCriterion) {
        target = encodeCriterionRecords(
          [record],
          pullRequest,
          roxabiRecordFixtures().projection,
          target.source.expectedAuthor,
          [origin],
          target,
        ).history
      } else {
        target = {
          ...target,
          operations: [
            ...target.operations,
            operation(record, { parts: [observedComment({ author: target.source.expectedAuthor })] }),
          ],
        }
      }
    },
    persistDecision: async (decision: Extract<CanonicalRecord, { kind: 'decision' }>) => {
      const result = await persistCauseDispositions(
        { causeContext: context },
        { kind: 'decision', decision },
        identity,
        store,
      )
      if (!result.ok) throw new Error(`review-disposition-refused:${result.diagnostics.join(',')}`)
      return result.value.refs
    },
    retainFailedSynthesis: async (history: DecodedHistory, diagnostic: string) => {
      const contributions = recordsOf(history).filter(
        (record): record is Extract<CanonicalRecord, { kind: 'contribution' }> =>
          record.kind === 'contribution' &&
          record.payload.inventoryId !== null &&
          [graph.root.recordId, graph.synthesis.recordId].includes(record.payload.inventoryId),
      )
      const result = await persistCauseDispositions(
        { causeContext: context },
        {
          kind: 'retained-output',
          contributions,
          diagnostics: [{ code: diagnostic, message: diagnostic }],
        },
        identity,
        store,
      )
      if (!result.ok) throw new Error(`review-disposition-refused:${result.diagnostics.join(',')}`)
    },
    readExternalHistories: async () => ({ ok: true as const, value: [origin] }),
    loadCatalogues: async () => fixtureHostReviewClassCatalogues(),
    onDecisionConfirmed: () => {},
  }
  return { graph, input, saved, getOrigin: () => origin, getTarget: () => target }
}

describe('review decision disposition ingress', () => {
  it('retains the nonblocking report even when independent criterion admission refuses the review', async () => {
    const test = fixture()
    await expect(finalizeReview(test.input)).rejects.toThrow(
      'decision-refused:unconfirmed,missing-declaration,criterion-changes',
    )
    const dispositions = recordsOf(test.getOrigin()).filter((record) => record.kind === 'cause-disposition')
    expect(dispositions).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          outcome: expect.objectContaining({ state: 'final', disposition: 'report', blocking: false }),
        }),
      }),
    ])
    expect(test.saved.map((record) => record.kind)).toEqual(['decision'])
  })

  it('publishes a criterion-admitted review after retaining its nonblocking report on the original UW', async () => {
    const test = fixture(false, true)
    await finalizeReview(test.input)
    const review = test.saved.find(
      (record): record is Extract<CanonicalRecord, { kind: 'review' }> => record.kind === 'review',
    )
    if (!review) throw new Error('expected final review')
    const dispositions = recordsOf(test.getOrigin()).filter((record) => record.kind === 'cause-disposition')
    expect(dispositions).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          outcome: expect.objectContaining({ state: 'final', disposition: 'report', blocking: false }),
        }),
      }),
    ])
    expect(review.payload.causeDispositionRefs).toEqual([
      { scope: original, kind: 'cause-disposition', recordId: dispositions[0]?.recordId },
    ])
    expect(test.saved.map((record) => record.kind)).toEqual(['decision', 'review'])
  })

  it('does not publish a usable review when original UW disposition readback is refused', async () => {
    const test = fixture(true)
    await expect(finalizeReview(test.input)).rejects.toThrow('correction-disposition-unconfirmed')
    expect(test.saved.map((record) => record.kind)).toEqual(['decision'])
    expect(recordsOf(test.getOrigin()).some((record) => record.kind === 'cause-disposition')).toBe(false)
  })
})
