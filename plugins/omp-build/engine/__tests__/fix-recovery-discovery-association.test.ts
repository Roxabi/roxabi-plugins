import { describe, expect, it } from 'vitest'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { resolveCorrectionRequestBasis } from '../correction-request-basis.ts'
import { discoverFixRecovery } from '../fix-recovery-discovery.ts'
import { parseRecord } from '../record-construction.ts'
import { recoveryAssociationFixture } from './fix-recovery-association-fixture.ts'

const fixturePromise = recoveryAssociationFixture()

describe('recovery discovery source associations', () => {
  it('recognizes an existing authenticated review decision without requiring a newly synthesized decision', async () => {
    const fixture = await fixturePromise
    const observed = fixture.observe({ review: true })
    const decisions = observed.prHistory.operations
      .map((operation) => operation.record)
      .filter(
        (record) => record?.kind === 'decision' && record.recordId === fixture.leaf.review.review.payload.decisionId,
      )
    const decision = decisions[0]
    if (decisions.length !== 1 || decision?.kind !== 'decision') throw new Error('Expected one decoded review decision')
    const basis = resolveCorrectionRequestBasis(
      observed.prHistory,
      observed.request,
      decision,
      fixtureReviewClassCatalogues(),
    )
    expect(basis.ok, JSON.stringify(basis)).toBe(true)
    const discovery = discoverFixRecovery(observed.input)
    expect(discovery, JSON.stringify(discovery)).toMatchObject({
      status: 'interrupted',
      phase: { kind: 'decided', decision: { identity: { recordId: fixture.leaf.review.decision.recordId } } },
    })
  })

  it('recognizes a complete request with its reserved future synthesis decision', async () => {
    const fixture = await fixturePromise
    const discovery = discoverFixRecovery(fixture.observe().input)
    expect(discovery, JSON.stringify(discovery)).toMatchObject({
      status: 'interrupted',
      phase: { kind: 'request-before-decision' },
    })
  })

  it.each(['source', 'request'] as const)('blocks complete %s absent from the sealed manifest', async (omit) => {
    const fixture = await fixturePromise
    expect(discoverFixRecovery(fixture.observe({ omit }).input).status).toBe('blocked')
  })

  it('blocks a complete fresh source from another run even when it is absent from the manifest', async () => {
    const fixture = await fixturePromise
    const sourceReservation = { ...fixture.sourceId, runId: 'foreign-run' }
    expect(discoverFixRecovery(fixture.observe({ sourceReservation, omit: 'source' }).input).status).toBe('blocked')
  })

  it('blocks a source reserved on the UW rather than the actual PR', async () => {
    const fixture = await fixturePromise
    const sourceReservation = { ...fixture.sourceId, scope: fixture.leaf.uw }
    expect(discoverFixRecovery(fixture.observe({ sourceReservation }).input).status).toBe('blocked')
  })

  it('blocks a fresh request whose operation is not derived from the opening prefix', async () => {
    const fixture = await fixturePromise
    const requestReservation = { ...fixture.requestId, operationId: 'another-operation' }
    expect(discoverFixRecovery(fixture.observe({ requestReservation }).input).status).toBe('blocked')
  })

  it('does not choose the first of competing future decision reservations', async () => {
    const fixture = await fixturePromise
    const other = fixture.identity('decision', 'other-decision')
    expect(discoverFixRecovery(fixture.observe({ decisions: [fixture.decisionId, other] }).input).status).toBe(
      'blocked',
    )
  })

  it('does not adopt a decision from an unrelated review synthesis as a fresh correction decision', async () => {
    const fixture = await fixturePromise
    const original = fixture.leaf.review.decision
    const parsed = parseRecord({
      ...original,
      recordId: fixture.decisionId.recordId,
      runId: fixture.decisionId.runId,
      operationId: fixture.decisionId.operationId,
    })
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics))
    const observed = fixture.observe({ extraRecords: [parsed.value] })
    expect(discoverFixRecovery(observed.input).status).toBe('blocked')
  })

  it('does not accept correction-shaped D without its own authenticated synthesis root', async () => {
    const fixture = await fixturePromise
    const original = fixture.leaf.review.decision
    if (original.payload.judgment.purpose !== 'review') throw new Error('Expected review decision fixture')
    const { standards: _standards, criterionVerdicts: _criterionVerdicts, ...judgment } = original.payload.judgment
    const parsed = parseRecord({
      ...original,
      recordId: fixture.decisionId.recordId,
      runId: fixture.decisionId.runId,
      operationId: fixture.decisionId.operationId,
      payload: { ...original.payload, judgment: { ...judgment, purpose: 'correction' } },
    })
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics))
    expect(discoverFixRecovery(fixture.observe({ extraRecords: [parsed.value] }).input).status).toBe('blocked')
  })
})
