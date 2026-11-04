import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { actionInputDigest } from '../engine/action-input.ts'
import { assessCauseDispositions, effectiveRejectedFindingIds } from '../engine/cause-disposition.ts'
import { causeAdjudicationProposalSchema } from '../engine/cause-disposition-schema.ts'
import { buildRecord, parseRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { acceptedPullRequestReviewGraph } from '../testing/record-graphs.ts'
import { observedComment, operation as observedOperation } from '../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { causeActionData } from './uw-action-cause-data.ts'
import { assertCurrentOutputClosure, currentRootOutputRefs } from './uw-action-closure.ts'
import type { DeliveryDataRef, UwActionRequest } from './uw-action-contract.ts'
import { selectedReviewInputs, selectedReviewRoot } from './uw-selected-review.ts'

const uw = { repository: 'acme/app', target: 'acme/app#42' }
const pr = { repository: 'acme/app', target: 'acme/app#44' }
const fixtures = roxabiWorkflowFixtures()
const mandate = fixtures.featureMandate(uw, { recordId: 'cause-mandate', body: 'Save the selected region' })
const binding = fixtures.workflowBinding(pr, mandate, 'feat/42-save', 'main')
if (binding.kind !== 'workflow-binding') throw new Error('Expected PR binding')
const pin = {
  source: 'git-file' as const,
  repository: uw.repository,
  commit: '1'.repeat(40),
  path: 'src/region.ts',
  digest: 'a'.repeat(64),
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function must<T>(
  result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string; message: string }[] },
): T {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '))
  return result.value
}
function ref<K extends CanonicalRecord>(record: K): { scope: typeof uw; kind: K['kind']; recordId: string } {
  return {
    scope: { repository: record.repository, target: record.target },
    kind: record.kind,
    recordId: record.recordId,
  }
}
function originalHistory(records: CanonicalRecord[] = []) {
  const baseline = fixtures.historyFrom([mandate])
  return {
    ...baseline,
    operations: [
      ...baseline.operations,
      ...records.map((record) =>
        observedOperation(record, {
          authority: 'accounted',
          parts: [
            observedComment({ author: 'operator', locator: `comment-${record.recordId}`, nativeId: record.recordId }),
          ],
        }),
      ),
    ],
  }
}
function actionFixture() {
  const initial = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'prior-root', label: 'issue' })
  const manifest = { ...initial.inputs.manifest, repositoryReferences: [pin] }
  const inputs = { ...initial.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  if (inputs.manifest.spec.kind !== 'accepted' || inputs.manifest.subject.kind !== 'uw')
    throw new Error('Expected accepted UW input')
  const graph = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'prior-root', label: 'issue', inputs })
  const context = { original: uw, effective: inputs.manifest.spec.effective }
  const assessed = must(
    assessCauseDispositions({
      context,
      source: { kind: 'decision', decision: graph.decision },
      histories: [originalHistory(), graph.history],
      adjudications: [],
    }),
  )
  const payload = assessed.outcomes.find(
    (item) => item.subject.kind === 'cause' && item.outcome.state === 'pending-blocking',
  )
  if (payload?.subject.kind !== 'cause') throw new Error('Expected a pending blocking cause')
  const pending = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'cause-initial',
      runId: 'run',
      operationId: 'cause-initial-op',
      kind: 'cause-disposition',
      payload,
    }),
  )
  const firstProposal = causeAdjudicationProposalSchema.parse({
    format: 'omp-build-cause-adjudication-proposal/1' as const,
    operationId: 'first-confirmation',
    operation: 'adjudicate-cause' as const,
    uw,
    pending: ref(pending),
    pendingDigest: hash(pending),
    rejectedFindingIds: [],
    judgment: payload.subject.cause.judgment,
    reason: 'The evidence remains contested after examination',
    references: [pin],
  })
  const firstDigest = hash(firstProposal)
  const firstOperation = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'first-intent',
      runId: 'run',
      operationId: 'first-intent-op',
      kind: 'cause-operation',
      payload: {
        format: 'omp-build-cause-operation/1',
        proposal: firstProposal,
        proposalDigest: firstDigest,
        confirmation: {
          route: 'omp-native-command',
          operationId: firstProposal.operationId,
          proposalDigest: firstDigest,
          confirmedAt: '2026-10-27T12:00:00.000Z',
        },
      },
    }),
  )
  const firstAssessment = must(
    assessCauseDispositions({
      context,
      source: { kind: 'decision', decision: graph.decision },
      histories: [originalHistory([pending, firstOperation]), graph.history],
      adjudications: [firstOperation],
    }),
  )
  const middlePayload = firstAssessment.outcomes.find((item) => item.previous?.recordId === pending.recordId)
  if (middlePayload?.outcome.state !== 'pending-blocking')
    throw new Error(`Expected a still-pending adjudication: ${JSON.stringify(firstAssessment)}`)
  const middle = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'cause-middle',
      runId: 'run',
      operationId: 'cause-middle-op',
      kind: 'cause-disposition',
      payload: middlePayload,
    }),
  )
  const proposal = causeAdjudicationProposalSchema.parse({
    format: 'omp-build-cause-adjudication-proposal/1' as const,
    operationId: 'adjudication-confirmation',
    operation: 'adjudicate-cause' as const,
    uw,
    pending: ref(middle),
    pendingDigest: hash(middle),
    rejectedFindingIds: payload.subject.findings.map((item) => item.id),
    judgment: null,
    reason: 'The selected evidence contradicts the reported failure',
    references: [pin],
  })
  const proposalDigest = hash(proposal)
  const operation = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'cause-intent',
      runId: 'run',
      operationId: 'cause-intent-op',
      kind: 'cause-operation',
      payload: {
        format: 'omp-build-cause-operation/1',
        proposal,
        proposalDigest,
        confirmation: {
          route: 'omp-native-command',
          operationId: proposal.operationId,
          proposalDigest,
          confirmedAt: '2026-10-27T12:00:00.000Z',
        },
      },
    }),
  )
  const adjudicated = must(
    assessCauseDispositions({
      context,
      source: { kind: 'decision', decision: graph.decision },
      histories: [originalHistory([pending, firstOperation, middle, operation]), graph.history],
      adjudications: [operation],
    }),
  )
  const successor = adjudicated.outcomes.find((item) => item.previous?.recordId === middle.recordId)
  if (successor?.outcome.state !== 'final' || successor.outcome.disposition !== 'report')
    throw new Error(`Expected authenticated motivated successor: ${JSON.stringify(adjudicated)}`)
  const head = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'cause-head',
      runId: 'run',
      operationId: 'cause-head-op',
      kind: 'cause-disposition',
      payload: successor,
    }),
  )
  const request: UwActionRequest = {
    actionId: graph.root.recordId,
    purpose: 'review',
    subject: inputs.manifest.subject,
    code: inputs.manifest.code,
    stageSources: [],
    expandedContext: [],
  }
  return { graph, inputs, pending, firstOperation, middle, operation, head, request }
}
function withData(inputs: ReturnType<typeof actionFixture>['inputs'], refs: DeliveryDataRef[]) {
  const manifest = { ...inputs.manifest, deliveryData: refs }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

describe('cause state as action data', () => {
  it('excludes the current review root output on replay, without a self-cycle or fingerprint drift', () => {
    const { graph, inputs, pending, request } = actionFixture()
    const before = [originalHistory(), graph.history]
    const after = [originalHistory([pending]), graph.history]
    const root = ref(graph.root)
    const beforeData = must(causeActionData(request, before, currentRootOutputRefs(request, before, root)))
    const outputs = currentRootOutputRefs(request, after, root)
    expect(
      outputs.some((item) => item.record.kind === 'decision' && item.record.recordId === graph.decision.recordId),
    ).toBe(true)
    const afterData = must(causeActionData(request, after, outputs))
    expect(withData(inputs, afterData).fingerprint).toBe(withData(inputs, beforeData).fingerprint)
    expect(assertCurrentOutputClosure(request, after, afterData, root)).toEqual({ ok: true, value: true })
  })

  it('refuses the selected review after a later adjudication and preserves its lineage for a new review', () => {
    const { graph, pending, firstOperation, middle, operation, head, request } = actionFixture()
    const histories = [originalHistory([pending, firstOperation, middle, operation, head]), graph.history]
    const selected = causeActionData(request, histories, currentRootOutputRefs(request, histories, ref(graph.root)))
    expect(selected.ok).toBe(false)
    if (!selected.ok) expect(selected.diagnostics.map((item) => item.code)).toContain('review-input-changed')
    const next = { ...request, actionId: 'new-review' }
    const refs = must(causeActionData(next, histories, currentRootOutputRefs(next, histories)))
    expect(refs.map((item) => item.record.recordId)).toEqual(
      expect.arrayContaining([
        pending.recordId,
        firstOperation.recordId,
        middle.recordId,
        operation.recordId,
        head.recordId,
      ]),
    )
  })

  it('does not attribute a same-fingerprint independent review to the selected root', () => {
    const { graph, inputs, pending, request } = actionFixture()
    const other = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'other-root', label: 'issue', inputs })
    if (pending.payload.subject.kind !== 'cause') throw new Error('Expected cause subject')
    const independent = must(
      parseRecord({
        ...pending,
        recordId: 'other-cause',
        operationId: 'other-cause-op',
        payload: { ...pending.payload, subject: { ...pending.payload.subject, decision: ref(other.decision) } },
      }),
    )
    const pull = { ...graph.history, operations: [...graph.history.operations, ...other.history.operations] }
    const histories = [originalHistory([pending, independent]), pull]
    expect(must(selectedReviewRoot(pull, graph.review.recordId)).recordId).toBe(graph.root.recordId)
    expect(must(selectedReviewRoot(pull, other.review.recordId)).recordId).toBe(other.root.recordId)
    const outputs = currentRootOutputRefs(request, histories, ref(graph.root))
    expect(outputs.some((item) => item.record.recordId === graph.decision.recordId)).toBe(true)
    expect(outputs.some((item) => item.record.recordId === other.decision.recordId)).toBe(false)
    const refs = must(causeActionData(request, histories, outputs))
    expect(refs.map((item) => item.record.recordId)).toContain(independent.recordId)
    expect(refs.map((item) => item.record.recordId)).not.toContain(pending.recordId)
    const withoutOther = withData(
      inputs,
      refs.filter((item) => item.record.recordId !== independent.recordId),
    )
    expect(withData(inputs, refs).fingerprint).not.toBe(withoutOther.fingerprint)
  })

  it('selects the authenticated root and prior cause lineage for each of three review epochs', () => {
    const { graph, inputs, pending, firstOperation, middle, operation, head, request } = actionFixture()
    const prior = [pending, firstOperation, middle, operation, head]
    const firstHistories = [originalHistory([pending]), graph.history]
    const secondRefs = must(causeActionData(request, firstHistories, []))
    const secondManifest = {
      ...inputs.manifest,
      code: { ...inputs.manifest.code, head: '2'.repeat(40), referenceCommit: '2'.repeat(40) },
      deliveryData: secondRefs,
    }
    const secondInputs = { ...inputs, manifest: secondManifest, fingerprint: actionInputDigest(secondManifest) }
    const second = acceptedPullRequestReviewGraph({
      mandate,
      binding,
      prefix: 'second-epoch',
      label: 'issue',
      inputs: secondInputs,
    })
    const histories = [originalHistory(prior), graph.history]
    const thirdRefs = must(causeActionData(request, histories, []))
    const thirdManifest = {
      ...inputs.manifest,
      code: { ...inputs.manifest.code, head: '3'.repeat(40), referenceCommit: '3'.repeat(40) },
      deliveryData: thirdRefs,
    }
    const thirdInputs = { ...inputs, manifest: thirdManifest, fingerprint: actionInputDigest(thirdManifest) }
    const third = acceptedPullRequestReviewGraph({
      mandate,
      binding,
      prefix: 'third-epoch',
      label: 'issue',
      inputs: thirdInputs,
    })
    const graphs = [graph, second, third]
    const pull = {
      ...graph.history,
      operations: [
        ...graph.history.operations,
        ...second.history.operations.filter((entry) => entry.record?.kind !== 'workflow-binding'),
        ...third.history.operations.filter((entry) => entry.record?.kind !== 'workflow-binding'),
      ],
    }
    expect(new Set(graphs.map((item) => item.inputs.fingerprint)).size).toBe(3)
    expect(thirdRefs.map((item) => item.record.recordId)).toEqual(
      expect.arrayContaining(prior.map((item) => item.recordId)),
    )
    expect(secondRefs.map((item) => item.record.recordId)).toContain(pending.recordId)
    for (const item of graphs) {
      const root = must(selectedReviewRoot(pull, item.review.recordId))
      expect(root.recordId).toBe(item.root.recordId)
      expect(must(selectedReviewInputs(pull, root, item.inputs.fingerprint)).manifest.code.head).toBe(
        item.inputs.manifest.code.head,
      )
    }
    expect(must(selectedReviewRoot(pull, third.review.recordId)).recordId).not.toBe(graph.root.recordId)
  })

  it('pins the complete prior adjudication lineage and makes it causal input to a new review', () => {
    const { graph, inputs, pending, firstOperation, middle, operation, head, request } = actionFixture()
    const histories = [originalHistory([pending, firstOperation, middle, operation, head]), graph.history]
    const next = { ...request, actionId: 'next-review-root' }
    const refs = must(causeActionData(next, histories, currentRootOutputRefs(next, histories)))
    const current = withData(inputs, refs)
    expect(current.fingerprint).not.toBe(inputs.fingerprint)
    const nextDecision = must(
      parseRecord({ ...graph.decision, recordId: 'next-decision', operationId: 'next-decision-op' }),
    )
    if (nextDecision.kind !== 'decision') throw new Error('Expected decision')
    const rejected = must(effectiveRejectedFindingIds({ decision: nextDecision, action: current, histories }))
    const finding = graph.decision.payload.judgment.findings[0]
    if (finding === undefined) throw new Error('Expected a finding in the prior review')
    expect(rejected).toEqual([finding.id])
    for (const removed of [pending.recordId, firstOperation.recordId, middle.recordId, operation.recordId]) {
      const incomplete = withData(
        inputs,
        refs.filter((item) => item.record.recordId !== removed),
      )
      expect(incomplete.fingerprint).not.toBe(current.fingerprint)
      const result = effectiveRejectedFindingIds({ decision: nextDecision, action: incomplete, histories })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('cause-adjudication-unconfirmed')
    }
    const withoutHead = withData(
      inputs,
      refs.filter((item) => item.record.recordId !== head.recordId),
    )
    expect(withoutHead.fingerprint).not.toBe(current.fingerprint)
    expect(must(effectiveRejectedFindingIds({ decision: nextDecision, action: withoutHead, histories }))).toEqual([])
    expect(assertCurrentOutputClosure(next, histories, refs)).toEqual({ ok: true, value: true })
  })

  it.each(['foreign', 'edited'] as const)(
    'refuses a %s adjudication instead of treating it as normative input',
    (change) => {
      const { graph, pending, firstOperation, middle, operation, head, request } = actionFixture()
      const clean = originalHistory([pending, firstOperation, middle, operation, head])
      const altered = {
        ...clean,
        operations: clean.operations.map((entry) => {
          if (entry.recordId !== operation.recordId) return entry
          return change === 'foreign'
            ? { ...entry, authority: 'foreign' as const }
            : { ...entry, parts: entry.parts.map((part) => ({ ...part, updatedAt: '2026-10-22T10:00:00Z' })) }
        }),
      }
      const next = { ...request, actionId: 'next-review-root' }
      const histories = [altered, graph.history]
      const result = causeActionData(next, histories, currentRootOutputRefs(next, histories))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('cause-chain-invalid')
    },
  )
})
