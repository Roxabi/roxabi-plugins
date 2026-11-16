import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validateRecoveryAdoptionPlan } from '../fix-recovery-adoption-assessment.ts'
import type { FixRecoveryCurrentFacts } from '../fix-recovery-observation.ts'
import { assessFixOwnerAdmission } from '../fix-recovery-owner-admission.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord } from '../record-construction.ts'
import { adoptionClaimFixture, append, type fixturePromise, required } from './fix-owner-admission-fixture.ts'

// Framed structural facts only, not live host evidence or native confirmation.
type EvidenceContext = {
  fixture: Awaited<typeof fixturePromise>
  source: { opening: { runId: string }; pr: DecodedHistory }
}
type Coordinate =
  | 'apply-1'
  | 'apply-2'
  | 'falsification-unlinked'
  | 'review-apply'
  | 'review-falsify'
  | 'review-restore-proof'
  | 'review-revalidate'

function executionEvidence({ fixture, source }: EvidenceContext, coordinate: Coordinate) {
  const decisionId = fixture.leaf.review.review.payload.decisionId
  const envelope = {
    ...fixture.leaf.pullRequest,
    version: 1 as const,
    runId: source.opening.runId,
    operationId: `evidence-${coordinate}`,
    recordId: `evidence-${coordinate}`,
  }
  if (coordinate === 'apply-1' || coordinate === 'apply-2') {
    return required(
      buildRecord({
        ...envelope,
        kind: 'correction-result',
        payload: {
          decisionId,
          causeDisposition: { scope: fixture.leaf.uw, kind: 'cause-disposition', recordId: 'observed-disposition' },
          causeId: 'observed-cause',
          attempt: coordinate === 'apply-1' ? 1 : 2,
          outcome: 'failed',
          commitSHAs: [],
          raw: {},
        },
      }),
    )
  }
  if (coordinate === 'falsification-unlinked') {
    return required(
      buildRecord({
        ...envelope,
        kind: 'falsification-result',
        payload: {
          correctionResultId: 'unobserved-correction',
          result: 'pass',
          notes: 'Observed without its correction',
          raw: {},
        },
      }),
    )
  }
  const inventory = source.pr.operations.find((operation) => operation.record?.kind === 'review-attempt')?.record
  if (inventory?.kind !== 'review-attempt') throw new Error('Missing review inventory')
  const phases = {
    'review-apply': 'apply',
    'review-falsify': 'falsify',
    'review-restore-proof': 'restore-proof',
    'review-revalidate': 'revalidate',
  } as const
  return required(
    buildRecord(
      {
        ...inventory,
        ...envelope,
        payload: {
          ...inventory.payload,
          slots: [
            {
              slotId: 'observed-slot',
              phase: 'fix',
              role: 'reviewer',
              chunk: null,
              required: true,
              output: 'action-result',
              classId: null,
              sourceFindingIds: [],
              correction: { phase: phases[coordinate], causeId: 'observed-cause', context: {} },
            },
          ],
        },
      },
      [decisionId],
    ),
  )
}

type Change = 'mandate' | 'accepted-spec' | 'plugin-pin' | 'binding' | 'dirty-local' | 'local-head' | 'remote-head'
function changedCurrent(current: FixRecoveryCurrentFacts, change: Change) {
  const authority = current.authority
  switch (change) {
    case 'mandate':
      return {
        ...current,
        authority: { ...authority, mandate: { ...authority.mandate, envelopeDigest: '2'.repeat(64) } },
      }
    case 'binding':
      return {
        ...current,
        authority: { ...authority, binding: { ...authority.binding, envelopeDigest: '2'.repeat(64) } },
      }
    case 'accepted-spec':
      return {
        ...current,
        authority: {
          ...authority,
          accepted: { ...authority.accepted, own: { ...authority.accepted.own, version: '2'.repeat(64) } },
        },
      }
    case 'plugin-pin':
      return { ...current, authority: { ...authority, plugin: { ...authority.plugin, commit: '2'.repeat(40) } } }
    case 'dirty-local': {
      const dirty = ' M unexplained.txt\n'
      return {
        ...current,
        local: {
          ...current.local,
          clean: false,
          status: { ...current.local.status, stdout: dirty },
          statusDigest: createHash('sha256').update(dirty).digest('hex'),
        },
      }
    }
    case 'local-head':
      return { ...current, local: { ...current.local, head: '2'.repeat(40) } }
    case 'remote-head':
      return { ...current, local: { ...current.local, remoteHead: '2'.repeat(40) } }
  }
}

describe('durable correction claim edges', () => {
  it.each([
    'apply-1',
    'apply-2',
    'falsification-unlinked',
    'review-apply',
    'review-falsify',
    'review-restore-proof',
    'review-revalidate',
  ] as const)('holds the same R/D when %s evidence appears', async (coordinate) => {
    const context = await adoptionClaimFixture()
    const { fixture, source, prepared, histories, base, claim } = context
    expect(assessFixOwnerAdmission({ ...base, claim })).toMatchObject({ ok: true, value: { status: 'claim' } })
    expect(
      validateRecoveryAdoptionPlan({
        proposal: prepared.proposal,
        histories: source.histories,
        graph: fixture.leaf.observation.graph,
      }).ok,
    ).toBe(true)
    expect(prepared.proposal.target.request.identity.recordId).toBe(fixture.requestId.recordId)
    expect(prepared.proposal.target.decision.identity.recordId).toBe(fixture.leaf.review.review.payload.decisionId)
    const evidence = executionEvidence(context, coordinate)
    const evidenceHistories = [source.home, append(source.pr, evidence, 99000)]
    const decision = validateRecoveryAdoptionPlan({
      proposal: prepared.proposal,
      histories: evidenceHistories,
      graph: fixture.leaf.observation.graph,
    })
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: false, diagnostics: [{ code: 'unconfirmed' }] })
    const originalPr = histories[1]
    const claimPr = append(originalPr, evidence, 99000)
    const claimHistories = [histories[0], claimPr]
    const refused = assessFixOwnerAdmission({
      ...base,
      histories: claimHistories,
      effectiveHistories: claimHistories,
      claim,
    })
    expect(refused.ok, JSON.stringify(refused)).toBe(false)
    expect(claimPr.source.comments).toEqual(expect.arrayContaining(originalPr.source.comments))
    expect(claimPr.operations.filter((op) => op.record?.kind === 'fix-request').map((op) => op.recordId)).toEqual([
      fixture.requestId.recordId,
    ])
  })

  it.each(['mandate', 'accepted-spec', 'plugin-pin', 'binding', 'dirty-local', 'local-head', 'remote-head'] as const)(
    'refuses a claim with changed current %s',
    async (change) => {
      const { base, claim } = await adoptionClaimFixture()
      expect(assessFixOwnerAdmission({ ...base, claim })).toMatchObject({ ok: true, value: { status: 'claim' } })
      const refused = assessFixOwnerAdmission({
        ...base,
        claim: { ...claim, current: changedCurrent(claim.current, change) },
      })
      expect(refused.ok, JSON.stringify(refused)).toBe(false)
    },
  )
})
