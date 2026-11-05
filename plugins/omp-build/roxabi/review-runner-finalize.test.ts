import { describe, expect, it } from 'vitest'
import {
  actionInputDigest,
  type CanonicalRecord,
  canonicalValueDigest,
  type DecodedHistory,
  decodeHistory,
  recordsOf,
  validateCauseDispositionRecords,
  validateFreshDecision,
} from '../dist/contracts.js'
import type { NativeChildResult } from '../omp/review-runtime/contracts.ts'
import { acceptedActionInputs } from '../testing/action-input-fixtures.ts'
import { criterionImplementationRecords } from '../testing/criterion-accepted-plan.ts'
import { criterionReviewGraph, encodeCriterionRecords } from '../testing/criterion-approval.ts'
import { criterionEpicReviewGraph } from '../testing/criterion-range-approval.ts'
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
  const mandate = fixtures.featureMandate(original, { branch: 'fix/42-save' })
  const binding = fixtures.workflowBinding(pullRequest, mandate, 'fix/42-save', 'main')
  const seed = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'green-finalization', label: 'suggestion' })
  const issueRecords = criterionImplementationRecords(mandate, seed.inputs.manifest.code.head)
  const missingImplementation = issueRecords.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
  )
  if (
    missingImplementation?.kind !== 'action-receipt' ||
    missingImplementation.payload.action !== 'implement' ||
    missingImplementation.payload.phase !== 'result' ||
    missingImplementation.payload.structured === null
  )
    throw new Error('fixture implementation result missing')
  const missingCriterion = missingImplementation.payload.structured.criteria[0]
  if (!missingCriterion) throw new Error('fixture criterion declaration missing')
  const missingDeclaration = {
    source: 'record' as const,
    role: 'implementation' as const,
    record: { scope: original, recordId: missingImplementation.recordId, kind: 'action-receipt' as const },
    selector: '/payload/structured/criteria/0',
    digest: canonicalValueDigest(missingCriterion),
  }
  const manifest = { ...seed.inputs.manifest, deliveryData: [missingDeclaration] }
  const base = validCriterion
    ? seed
    : acceptedPullRequestReviewGraph({
        mandate,
        binding,
        prefix: 'green-finalization',
        label: 'suggestion',
        inputs: { ...seed.inputs, manifest, fingerprint: actionInputDigest(manifest) },
      })
  const built = (() => {
    if (!validCriterion)
      return {
        graph: base,
        origin: fixtures.historyFrom(
          issueRecords.filter((record) => record.recordId !== missingImplementation.recordId),
        ),
      }
    const head = base.inputs.manifest.code.head
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
  const confirmed: string[] = []
  const verdicts: (string | null)[] = []
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
      const fresh = validateFreshDecision(
        decision,
        target,
        fixtureHostReviewClassCatalogues(),
        null,
        [origin],
        target,
        result.value.refs,
      )
      if (!fresh.ok) throw new Error(`fresh-decision-refused:${fresh.diagnostics.map((item) => item.code).join(',')}`)
      verdicts.push(fresh.value.verdict)
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
    onDecisionConfirmed: (id: string) => {
      confirmed.push(id)
    },
  }
  return { graph, input, saved, confirmed, verdicts, getOrigin: () => origin, getTarget: () => target }
}

describe('same-scope epic disposition readback', () => {
  it('confirms the decision after persisted dispositions are visible in the epic history', async () => {
    const fixtures = roxabiWorkflowFixtures()
    const mandate = fixtures.epicMandate(original, [])
    const accepted = acceptedActionInputs(mandate, 'review')
    const base = 'a'.repeat(40)
    const head = 'b'.repeat(40)
    const range = `${base}..${head}`
    const manifest = {
      ...accepted.manifest,
      code: { ...accepted.manifest.code, repository: original.repository, base, head },
      acceptedSources: [
        {
          source: 'record' as const,
          record: { scope: original, recordId: mandate.recordId, kind: mandate.kind },
          selector: '/payload',
          digest: canonicalValueDigest(mandate.payload),
        },
      ],
    }
    const inputs = { ...accepted, manifest, fingerprint: actionInputDigest(manifest) }
    const graph = criterionEpicReviewGraph({
      mandate,
      inputs,
      head,
      range,
      prefix: 'same-scope-finalization',
      blocking: true,
    })
    if (graph.inputs.manifest.spec.kind !== 'accepted') throw new Error('accepted fixture required')
    const effective = graph.inputs.manifest.spec.effective
    const projection = roxabiRecordFixtures().projection
    let history = encodeCriterionRecords(
      [
        fixtures.identityAllocation(original),
        ...graph.issueRecords,
        ...graph.records.filter((record) => record.recordId !== graph.decision.recordId),
      ],
      original,
      projection,
      'operator',
    ).history
    const identity = {
      runId: 'same-scope-run',
      operationId: 'same-scope-operation',
      nextRecordId: (kind: string) => `same-scope-${kind}`,
    }
    const store: FixDispositionStore = {
      catalogues: async () => fixtureHostReviewClassCatalogues(),
      read: async () => ({ ok: true, value: [history] }),
      publish: async (record) => {
        history = encodeCriterionRecords([record], original, projection, 'operator', [], history).history
        const operation = history.operations.find((item) => item.recordId === record.recordId)
        if (operation?.status !== 'complete' || operation.record === null)
          throw new Error(`disposition-readback-missing:${record.recordId}`)
        return { status: 'confirmed', operation }
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
    const confirmed: string[] = []
    let dispositionIds: string[] = []
    await finalizeReview({
      review: {
        context: { subject: { kind: 'epic-range', range }, candidateGitSHA: head, input: graph.root.payload.input },
        policy: { version: 'baseline' },
        canonicalClasses: [],
        authorize: async () => ({ ok: true }),
      },
      identity: {
        runId: identity.runId,
        operationId: identity.operationId,
        next: (kind) => (kind === 'decision' ? graph.decision.recordId : `same-scope-${kind}`),
      },
      scope: original,
      contributions: [{ id: graph.synthesisContribution.recordId, child }],
      inventories: [graph.root.recordId, graph.synthesis.recordId],
      canContinue: () => true,
      readHistory: async () => history,
      publish: async (record) => {
        history = encodeCriterionRecords([record], original, projection, 'operator', [], history).history
      },
      persistDecision: async (decision) => {
        const result = await persistCauseDispositions(
          { causeContext: { original, effective } },
          { kind: 'decision', decision },
          identity,
          store,
        )
        if (!result.ok) throw new Error(`review-disposition-refused:${result.diagnostics.join(',')}`)
        const fresh = validateFreshDecision(
          decision,
          history,
          fixtureHostReviewClassCatalogues(),
          null,
          [],
          history,
          result.value.refs,
        )
        expect(fresh).toMatchObject({ ok: true, value: { admissible: true } })
        dispositionIds = result.value.refs.map((ref) => ref.recordId)
        return result.value.refs
      },
      retainFailedSynthesis: async () => {
        throw new Error('unexpected failed synthesis')
      },
      readExternalHistories: async () => ({ ok: true, value: [] }),
      loadCatalogues: async () => fixtureHostReviewClassCatalogues(),
      onDecisionConfirmed: (id) => {
        confirmed.push(id)
      },
    })
    expect(dispositionIds).toHaveLength(1)
    expect(
      recordsOf(history)
        .filter((record) => record.kind === 'cause-disposition')
        .map((record) => record.recordId),
    ).toEqual(dispositionIds)
    expect(confirmed).toEqual([graph.decision.recordId])
    expect(recordsOf(history).some((record) => record.kind === 'review')).toBe(false)
  })
})

describe('review decision disposition ingress', () => {
  it('retains the nonblocking report while incomplete criterion admission requests changes', async () => {
    const test = fixture()
    await finalizeReview(test.input)
    const decision = test.saved.find((record) => record.kind === 'decision')
    if (decision?.kind !== 'decision') throw new Error('expected saved decision')
    expect(test.verdicts).toEqual(['Request changes'])
    expect(test.confirmed).toEqual([decision.recordId])
    const dispositions = recordsOf(test.getOrigin()).filter((record) => record.kind === 'cause-disposition')
    expect(dispositions).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          outcome: expect.objectContaining({ state: 'final', disposition: 'report', blocking: false }),
        }),
      }),
    ])
    expect(test.saved.map((record) => record.kind)).toEqual(['decision', 'review'])
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
