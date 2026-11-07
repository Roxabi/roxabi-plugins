import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import {
  authenticatedReview,
  causeFixtureGraph,
  causeOriginalHistory,
  sisterRecords,
} from '../../testing/cause-input-fixture.ts'
import { causeFixtureMandate } from '../../testing/cause-input-specification.ts'
import { contributionActionCapture, synthesisActionCapture } from '../../testing/criterion-dispositions.ts'
import { canonicalValueDigest } from '../action-input.ts'
import { assessAdjudicationSuccessor } from '../cause-adjudication-successor.ts'
import { assessCauseDispositions, validateCauseAdjudication } from '../cause-disposition.ts'
import { causeAdjudicationProposalSchema } from '../cause-disposition-schema.ts'
import { assessCauseHolds } from '../cause-hold.ts'
import { buildRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Scope } from '../record-values.ts'
import { assessUwAdmission } from '../uw-admission.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import type { UwCompletionObservation } from '../uw-completion-types.ts'
import type { UwNativeNode } from '../uw-graph.ts'
import type { SpecIdentityLedger } from '../uw-identity.ts'
import { projectUwWaits } from '../uw-waits.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import { ref } from './cause-hold-fixture.ts'
import { history, must } from './workflow-test-support.ts'

const uw: Scope = { repository: 'acme/app', target: 'acme/app#42' }
const sister: Scope = { repository: 'acme/app', target: 'acme/app#43' }
const foreign: Scope = { repository: 'acme/app', target: 'acme/app#44' }
const now = '2026-10-27T12:00:00.000Z'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const mandate = causeFixtureMandate()
const ownSpec = mandate.payload.ownSpec
const resolvedAccepted = resolveAcceptedSpec(mandate, [causeOriginalHistory()])
if (!resolvedAccepted.ok)
  throw new Error(`Expected authenticated accepted Spec: ${JSON.stringify(resolvedAccepted.evidence)}`)
const accepted = resolvedAccepted.spec
const identityAllocation = ownSpec.identityAllocations[0]
if (identityAllocation === undefined) throw new Error('Expected an allocated criterion identity')
const identities: SpecIdentityLedger = {
  uw,
  head: null,
  nextCriterion: '2',
  nextInvariant: '1',
  allocations: new Map([['C1', identityAllocation]]),
  retired: new Map(),
}
const evidence = {
  source: 'git-file' as const,
  repository: uw.repository,
  commit: '1'.repeat(40),
  path: 'src/region.ts',
  digest: 'a'.repeat(64),
}

function disposition(id: string, _outcome: 'pending') {
  const { pending } = authenticatedSuccessor()
  return must(buildRecord({ ...pending, recordId: id, operationId: `op-${id}` }))
}
function node(scope: Scope, blockers: Scope[] = [], completed = false): UwNativeNode {
  return {
    uw: scope,
    title: `UW ${scope.target}`,
    raw:
      scope.repository === uw.repository && scope.target === uw.target
        ? ownSpec.snapshot.raw
        : { reference: scope.target, body: '', bodySha256: specDigest(''), lastEditedAt: now },
    updatedAt: now,
    labels: ['size:S'],
    wayfinderLabels: [],
    parent: null,
    children: [],
    blockers,
    native: { state: completed ? 'CLOSED' : 'OPEN', stateReason: completed ? 'COMPLETED' : null },
  }
}
const originalHistory = causeOriginalHistory
function admission(
  records: CanonicalRecord[],
  options: {
    sisterHistory?: ReturnType<typeof history>
    sourceHistory?: ReturnType<typeof history>
    blocker?: 'open' | 'completed'
    detached?: boolean
    proposedChanged?: boolean
    originHistory?: ReturnType<typeof history>
  } = {},
) {
  const original = options.originHistory ?? originalHistory(records)
  const nodes = options.blocker
    ? [node(uw, options.detached ? [] : [sister]), node(sister, [], options.blocker === 'completed')]
    : [node(uw)]
  const graph = { status: 'complete' as const, root: uw, nodes, observedAt: now }
  const histories = [
    original,
    ...(options.sourceHistory ? [options.sourceHistory] : []),
    ...(options.sisterHistory ? [options.sisterHistory] : []),
  ]
  const catalogues = fixtureReviewClassCatalogues()
  const facts = { root: uw, graph, histories, catalogues, delivery: [] }
  const observation: UwCompletionObservation = histories.every((item) => item.source.complete)
    ? { status: 'complete', ...facts }
    : {
        status: 'incomplete',
        ...facts,
        diagnostics: [
          {
            code: 'history-unconfirmed',
            message: 'Fixture history is incomplete',
            location: { kind: 'native', uw, connection: 'state' },
            related: [],
          },
        ],
      }
  return assessUwAdmission({
    uw,
    graph,
    proposed: options.proposedChanged ? { ok: false, diagnostics: [] } : { ok: true, snapshot: ownSpec.snapshot },
    accepted: { status: 'accepted', value: accepted },
    identities,
    histories,
    catalogues,
    completion: assessUwCompletion(observation),
    phase: 'delivery-transition',
    currentChildren: { ok: true, value: [] },
  })
}
const codes = (result: ReturnType<typeof admission>) => result.deliverable.diagnostics.map((item) => item.code)

function successor(
  pending: ReturnType<typeof disposition>,
  id: string,
  options: { editedDigest?: boolean; foreignPending?: boolean } = {},
) {
  const proposal = causeAdjudicationProposalSchema.parse({
    format: 'omp-build-cause-adjudication-proposal/1' as const,
    operationId: `adjudicate-${id}`,
    operation: 'adjudicate-cause' as const,
    uw,
    pending: options.foreignPending ? { ...ref(pending), scope: foreign } : ref(pending),
    pendingDigest: options.editedDigest ? '0'.repeat(64) : digest(pending),
    rejectedFindingIds: ['finding-region'],
    judgment: null,
    reason: 'The cited observation contradicts the reported failure',
    references: [evidence],
  })
  const proposalDigest = digest(proposal)
  const operation = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: `intent-${id}`,
      runId: 'run',
      operationId: `op-intent-${id}`,
      kind: 'cause-operation',
      payload: {
        format: 'omp-build-cause-operation/1',
        proposal,
        proposalDigest,
        confirmation: {
          route: 'omp-native-command',
          operationId: proposal.operationId,
          proposalDigest,
          confirmedAt: now,
        },
      },
    }),
  )
  const resolved = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: id,
      runId: 'run',
      operationId: `op-${id}`,
      kind: 'cause-disposition',
      payload: {
        ...pending.payload,
        previous: ref(pending),
        adjudication: ref(operation),
        outcome: {
          state: 'final',
          disposition: 'report',
          blocking: false,
          reason: 'The finding was rejected on the cited evidence',
        },
      },
    }),
  )
  return [operation, resolved] as const
}

function authenticatedSuccessor() {
  const { graph, context } = authenticatedReview()
  const originHistory = originalHistory()
  const initial = must(
    assessCauseDispositions({
      context,
      capture: synthesisActionCapture(graph.decision, [graph.history]),
      graph: causeFixtureGraph(),
      source: { kind: 'decision', decision: graph.decision },
      histories: [originHistory, graph.history],
      adjudications: [],
      catalogues: fixtureReviewClassCatalogues(),
    }),
  )
  const pendingPayload = initial.outcomes.find(
    (item) => item.subject.kind === 'cause' && item.outcome.state === 'pending-blocking',
  )
  if (pendingPayload?.subject.kind !== 'cause') throw new Error('Expected an authenticated pending cause')
  const pending = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'authenticated-pending',
      runId: 'run',
      operationId: 'pending-op',
      kind: 'cause-disposition',
      payload: pendingPayload,
    }),
  )
  const proposal = causeAdjudicationProposalSchema.parse({
    format: 'omp-build-cause-adjudication-proposal/1' as const,
    operationId: 'authenticated-adjudication',
    operation: 'adjudicate-cause' as const,
    uw,
    pending: ref(pending),
    pendingDigest: digest(pending),
    rejectedFindingIds: pendingPayload.subject.findings.map((finding) => finding.id),
    judgment: null,
    reason: 'The selected source contradicts the reported failure',
    references: [evidence],
  })
  const proposalDigest = digest(proposal)
  const operation = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'authenticated-intent',
      runId: 'run',
      operationId: 'intent-op',
      kind: 'cause-operation',
      payload: {
        format: 'omp-build-cause-operation/1',
        proposal,
        proposalDigest,
        confirmation: {
          route: 'omp-native-command',
          operationId: proposal.operationId,
          proposalDigest,
          confirmedAt: now,
        },
      },
    }),
  )
  const assessed = must(
    assessCauseDispositions({
      context,
      capture: synthesisActionCapture(graph.decision, [graph.history]),
      graph: causeFixtureGraph(),
      source: { kind: 'decision', decision: graph.decision },
      histories: [originalHistory([pending, operation]), graph.history],
      adjudications: [operation],
      catalogues: fixtureReviewClassCatalogues(),
    }),
  )
  const successorPayload = assessed.outcomes.find((item) => item.previous?.recordId === pending.recordId)
  if (successorPayload?.outcome.state !== 'final' || successorPayload.outcome.disposition !== 'report')
    throw new Error(`Expected a motivated adjudicated report: ${JSON.stringify(assessed)}`)
  const resolved = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'authenticated-resolved',
      runId: 'run',
      operationId: 'resolved-op',
      kind: 'cause-disposition',
      payload: successorPayload,
    }),
  )
  return { graph, pending, operation, resolved }
}

it.each(['retained-finding', 'rule-error'] as const)('accepts motivated exact %s adjudication', (kind) => {
  const { graph, context } = authenticatedReview()
  const panel = recordsOf(graph.history).find((record) => record.recordId === graph.panel.recordId)
  if (panel?.kind !== 'contribution') throw new Error('Expected authenticated panel contribution')
  const assessed = must(
    assessCauseDispositions({
      context,
      capture: contributionActionCapture(panel, [graph.history]),
      graph: causeFixtureGraph(),
      source: {
        kind: 'retained-output',
        contributions: [panel],
        diagnostics: [{ code: 'raw-error', message: 'Incomplete output' }],
      },
      histories: [originalHistory(), graph.history],
      adjudications: [],
      catalogues: fixtureReviewClassCatalogues(),
    }),
  )
  const payload = assessed.outcomes.find((item) => item.subject.kind === kind)
  if (!payload) throw new Error('Expected retained pending')
  const pending = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: `pending-${kind}`,
      runId: 'run',
      operationId: `op-${kind}`,
      kind: 'cause-disposition',
      payload,
    }),
  )
  const references = [
    {
      source: 'record' as const,
      record: ref(pending),
      selector: '/payload',
      digest: canonicalValueDigest(pending.payload),
    },
  ]
  const proposal = causeAdjudicationProposalSchema.parse({
    format: 'omp-build-cause-adjudication-proposal/1',
    operationId: `resolve-${kind}`,
    operation: 'adjudicate-cause',
    uw,
    pending: ref(pending),
    pendingDigest: digest(pending),
    rejectedFindingIds: payload.subject.kind === 'retained-finding' ? [payload.subject.finding.id] : [],
    judgment: null,
    reason: 'The authenticated source was reviewed',
    references,
  })
  expect(
    validateCauseAdjudication({
      proposal,
      pending,
      context,
      histories: [originalHistory([pending]), graph.history],
    }),
  ).toEqual([])
  const proposalDigest = digest(proposal)
  const operation = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: `intent-${kind}`,
      runId: 'run',
      operationId: `intent-op-${kind}`,
      kind: 'cause-operation',
      payload: {
        format: 'omp-build-cause-operation/1',
        proposal,
        proposalDigest,
        confirmation: {
          route: 'omp-native-command',
          operationId: proposal.operationId,
          proposalDigest,
          confirmedAt: now,
        },
      },
    }),
  )
  const successor = must(
    assessAdjudicationSuccessor({
      pending,
      operation,
      histories: [originalHistory([pending, operation]), graph.history],
      catalogues: fixtureReviewClassCatalogues(),
    }),
  )
  expect(successor.subject).toEqual(pending.payload.subject)
  expect(successor.origin).toEqual(pending.payload.origin)
  expect(successor.outcome).toEqual({ state: 'final', disposition: 'report', blocking: false, reason: proposal.reason })
})

describe('cause holds at UW admission', () => {
  it('holds a framed, accepted UW for a pending blocking cause', () => {
    const { graph, pending } = authenticatedSuccessor()
    const result = admission([pending], { sourceHistory: graph.history })
    expect(result.framed.ok).toBe(true)
    expect(result.deliverable.ok).toBe(false)
    expect(codes(result)).toEqual(['cause-adjudication-required'])
  })

  it('holds a blocking sister until its receipt is confirmed', () => {
    const { graph, held } = sisterRecords()
    const result = admission([held], { sourceHistory: graph.history })
    expect(result.framed.ok).toBe(true)
    expect(codes(result)).toEqual(['cause-sister-confirmation-required'])
    expect(result.deliverable.ok).toBe(false)
  })

  it('refuses a receipt with missing or mismatching sister identity and confirmation', () => {
    const { graph, held, operation, identity, receipt } = sisterRecords()
    const original = [held, operation, receipt]
    const sourceHistory = graph.history
    expect(codes(admission(original, { sourceHistory }))).toContain('cause-effect-unconfirmed')
    expect(admission(original, { sourceHistory, sisterHistory: history([], sister) }).deliverable.ok).toBe(false)
    if (identity.payload.event !== 'allocate') throw new Error('Expected an allocation identity')
    const wrongAllocation = must(
      buildRecord({ ...identity, payload: { ...identity.payload, allocations: [{ draftKey: 'repair', id: 'C2' }] } }),
    )
    expect(codes(admission(original, { sourceHistory, sisterHistory: history([wrongAllocation], sister) }))).toContain(
      'cause-effect-mismatch',
    )
    const altered = must(
      buildRecord({
        ...identity,
        payload: {
          ...identity.payload,
          confirmation: { ...identity.payload.confirmation, confirmedAt: '2026-10-28T12:00:00.000Z' },
        },
      }),
    )
    expect(codes(admission(original, { sourceHistory, sisterHistory: history([altered], sister) }))).toContain(
      'cause-effect-mismatch',
    )
    const histories = [
      history([mandate, ...original], uw),
      sourceHistory,
      history([identity], { repository: uw.repository, target: 'acme/app#45' }),
    ]
    const waits = projectUwWaits({
      graph: { status: 'complete', root: uw, nodes: [node(uw)], observedAt: now },
      histories,
      catalogues: fixtureReviewClassCatalogues(),
    })
    expect(assessCauseHolds({ uw, waits, dependencies: new Map() }).map((d) => d.code)).toContain(
      'cause-effect-unconfirmed',
    )
  })

  it('keeps the native blocker held after a valid receipt when the allocated sister lacks delivery', () => {
    const { graph, held, operation, identity, receipt } = sisterRecords()
    const records = [held, operation, receipt]
    const sisterHistory = history([identity], sister)
    const open = admission(records, { sourceHistory: graph.history, sisterHistory, blocker: 'open' })
    expect(open.deliverable.ok).toBe(false)
    expect(codes(open)).toContain('blocker-not-completed')
    expect(codes(open)).not.toContain('cause-sister-confirmation-required')
    const completed = admission(records, { sourceHistory: graph.history, sisterHistory, blocker: 'completed' })
    expect(codes(completed)).toContain('blocker-not-completed')
  })

  it('keeps the confirmed sister obligation after the native edge disappears', () => {
    const { graph, held, operation, identity, receipt } = sisterRecords()
    const records = [held, operation, receipt]
    const options = { sourceHistory: graph.history, sisterHistory: history([identity], sister) }
    expect(admission(records, options).deliverable.ok).toBe(false)
    expect(admission(records, { ...options, detached: true, blocker: 'open' }).deliverable.ok).toBe(false)
    expect(admission(records, { ...options, detached: true, blocker: 'completed' }).deliverable.ok).toBe(false)
  })

  it('admits the authenticated adjudicated successor without bypassing native or Spec obligations', () => {
    const { graph, pending, operation, resolved } = authenticatedSuccessor()
    const records = [pending, operation, resolved]
    const sourceHistory = graph.history
    expect(admission(records, { sourceHistory }).deliverable).toEqual({ ok: true, diagnostics: [] })
    const independent = admission(records, { sourceHistory, blocker: 'open', proposedChanged: true })
    expect(independent.deliverable.ok).toBe(false)
    expect(codes(independent)).toEqual(expect.arrayContaining(['blocker-not-completed', 'proposed-spec-unavailable']))
    const { context } = authenticatedReview()
    const panel = recordsOf(sourceHistory).find((record) => record.recordId === graph.panel.recordId)
    if (panel?.kind !== 'contribution') throw new Error('Expected authenticated panel contribution')
    const retainedAssessment = must(
      assessCauseDispositions({
        context,
        capture: contributionActionCapture(panel, [sourceHistory]),
        graph: causeFixtureGraph(),
        source: {
          kind: 'retained-output',
          contributions: [panel],
          diagnostics: [{ code: 'partition-error', message: 'A separate finding was not classified' }],
        },
        histories: [originalHistory(records), sourceHistory],
        adjudications: [],
        catalogues: fixtureReviewClassCatalogues(),
      }),
    )
    const retainedPayload = retainedAssessment.outcomes.find((item) => item.subject.kind === 'rule-error')
    if (!retainedPayload) throw new Error('Expected authenticated retained rule error')
    const unrelated = must(
      buildRecord({
        version: 1,
        ...uw,
        recordId: 'unrelated-rule-error',
        runId: 'run',
        operationId: 'unrelated-rule-error-op',
        kind: 'cause-disposition',
        payload: retainedPayload,
      }),
    )
    const retained = admission([...records, unrelated], { sourceHistory })
    expect(retained.deliverable.ok).toBe(false)
  })

  it('refuses an apparently confirmed successor without its decision and citation provenance', () => {
    const { graph, pending, operation, resolved } = authenticatedSuccessor()
    const records = [pending, operation, resolved]
    expect(admission(records, { sourceHistory: graph.history }).deliverable).toEqual({ ok: true, diagnostics: [] })
    const result = admission(records)
    expect(result.deliverable.ok).toBe(false)
    expect(codes(result).some((code) => code === 'cause-source-unconfirmed' || code === 'missing-history')).toBe(true)
  })

  it.each(['foreign', 'edited'] as const)('refuses a %s decision source even with a confirmed successor', (change) => {
    const { graph, pending, operation, resolved } = authenticatedSuccessor()
    const records = [pending, operation, resolved]
    const original = admission(records, { sisterHistory: graph.history })
    expect(codes(original)).not.toContain('cause-source-unconfirmed')
    const damaged = {
      ...graph.history,
      operations: graph.history.operations.map((entry) => {
        if (entry.recordId !== graph.decision.recordId) return entry
        return change === 'foreign'
          ? { ...entry, authority: 'foreign' as const }
          : { ...entry, parts: entry.parts.map((part) => ({ ...part, updatedAt: '2026-10-22T10:00:00Z' })) }
      }),
    }
    const result = admission(records, { sisterHistory: damaged })
    expect(result.deliverable.ok).toBe(false)
    expect(codes(result)).toContain('cause-source-unconfirmed')
  })

  it('refuses competing successors and incomplete authenticated histories', () => {
    const pending = disposition('pending', 'pending')
    const records = [mandate, pending, ...successor(pending, 'first'), ...successor(pending, 'second')]
    expect(codes(admission([], { originHistory: history(records, uw) }))).toContain('cause-chain-competing')
    const incomplete = history([mandate, pending], uw)
    expect(
      codes(admission([], { originHistory: { ...incomplete, source: { ...incomplete.source, complete: false } } })),
    ).toContain('cause-history-unconfirmed')
  })

  it.each([{ editedDigest: true }, { foreignPending: true }])(
    'does not release a hold using an edited or foreign adjudication (%o)',
    (options) => {
      const pending = disposition('pending', 'pending')
      const result = admission([pending, ...successor(pending, 'attempt', options)])
      expect(result.deliverable.ok).toBe(false)
      expect(codes(result)).toContain('cause-chain-invalid')
    },
  )

  it('does not trust a foreign author or an edited native adjudication record', () => {
    const pending = disposition('pending', 'pending')
    const [operation, resolved] = successor(pending, 'resolved')
    const observed = history([mandate, pending, operation, resolved], uw)
    const foreignAuthor = {
      ...observed,
      operations: observed.operations.map((entry) =>
        entry.recordId === operation.recordId ? { ...entry, authority: 'foreign' as const } : entry,
      ),
    }
    const edited = {
      ...observed,
      operations: observed.operations.map((entry) =>
        entry.recordId === operation.recordId
          ? { ...entry, parts: entry.parts.map((part) => ({ ...part, updatedAt: '2026-10-22T10:00:00Z' })) }
          : entry,
      ),
    }
    expect(codes(admission([], { originHistory: foreignAuthor }))).toContain('cause-chain-invalid')
    expect(codes(admission([], { originHistory: edited }))).toContain('cause-chain-invalid')
  })
})
