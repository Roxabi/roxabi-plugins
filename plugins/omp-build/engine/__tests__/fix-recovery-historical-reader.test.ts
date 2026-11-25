import { describe, expect, it } from 'vitest'
import { projectRecoveryHistories } from '../../adapters/github/history-codec.ts'
import { inspectRecoveryHistoricalFacts } from '../fix-recovery-historical-facts.ts'
import { fixRecoveryProposalFromControl } from '../fix-recovery-proposal.ts'
import { hasObservedRecordPin } from '../historical-record-pins.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import { equalScope } from '../record-diagnostics.ts'
import { historicalRecoveryFixture, required } from './fix-recovery-historical-reader-fixture.ts'

function operation(history: DecodedHistory, recordId: string) {
  return history.operations.find((entry) => entry.recordId === recordId)
}

describe('legacy correction recovery history', () => {
  it('replays a predecision close and retires a late reserved decision fragment only from effective history', async () => {
    const fixture = await historicalRecoveryFixture('close-predecision')
    const pr = fixture.withLateDecisionFragment(fixture.readBack())
    const rawComments = [...pr.source.comments]
    expect(operation(pr, fixture.decisionId)?.status).toBe('incomplete')

    const [, effective] = required(projectRecoveryHistories([fixture.home, pr]))
    if (!effective) throw new Error('Expected projected pull-request history')
    expect(operation(effective, fixture.record.recordId)?.record).toEqual(fixture.record)
    expect(operation(effective, fixture.requestId)?.status).toBe('complete')
    expect(operation(effective, fixture.decisionId)).toBeUndefined()
    expect(effective.source.comments).toEqual(rawComments)
  })

  it('replays an adoption while retaining the original request and selected decision', async () => {
    const fixture = await historicalRecoveryFixture('adopt-decision')
    const pr = fixture.readBack()

    const [, effective] = required(projectRecoveryHistories([fixture.home, pr]))
    if (!effective) throw new Error('Expected projected pull-request history')
    expect(operation(effective, fixture.record.recordId)?.record).toEqual(fixture.record)
    expect(operation(effective, fixture.requestId)?.status).toBe('complete')
    expect(operation(effective, fixture.decisionId)?.status).toBe('complete')
  })

  it.each(['pin-only', 'finite-cut'] as const)(
    'replays a native-action adoption with authenticated %s foreign expansion',
    async (mode) => {
      const fixture = await historicalRecoveryFixture('adopt-decision', false, mode)
      const foreign = fixture.foreign
      if (foreign === null) throw new Error('Expected an independently observed foreign source')
      const pr = await fixture.readBackWithForeignExpansion('current')
      const raw = [fixture.home, pr]
      const proposal = required(fixRecoveryProposalFromControl(fixture.record))
      const facts = required(inspectRecoveryHistoricalFacts(proposal, raw))
      const cited = facts.histories.find((history) => equalScope(history.source.scope, foreign.ref.record.scope))

      if (mode === 'pin-only') expect(cited).toBeUndefined()
      else {
        expect(cited?.source.comments).toEqual(foreign.original.source.comments)
        expect(cited?.operations.map((entry) => entry.recordId)).toEqual([foreign.ref.record.recordId])
      }
      const [, effective] = required(projectRecoveryHistories(raw))
      if (!effective) throw new Error('Expected projected pull-request history')
      expect(operation(effective, fixture.record.recordId)?.record).toEqual(fixture.record)
    },
  )

  it.each([
    { mode: 'pin-only', code: 'missing-history' },
    { mode: 'finite-cut', code: 'incomplete' },
  ] as const)('rejects native-action adoption with changed foreign content ($mode)', async ({ mode, code }) => {
    const fixture = await historicalRecoveryFixture('adopt-decision', false, mode)
    const pr = await fixture.readBackWithForeignExpansion('changed')
    expect(operation(pr, fixture.record.recordId)?.record).toEqual(fixture.record)
    expect(projectRecoveryHistories([fixture.home, pr])).toMatchObject({
      ok: false,
      diagnostics: [{ code }],
    })
  })

  it.each(['same-second', 'published-later'] as const)(
    'does not replay an adoption when its missing pin-only expansion cannot be shown to predate the control (%s)',
    async (version) => {
      const fixture = await historicalRecoveryFixture('adopt-decision', false, 'pin-only')
      const foreign = fixture.foreign
      if (foreign === null) throw new Error('Expected a foreign expansion fixture')
      const pr = fixture.readBack()
      const before = await foreign.observe(pr, fixture.record, 'absent')
      expect(operation(before, fixture.record.recordId)?.record).toEqual(fixture.record)
      expect(projectRecoveryHistories([fixture.home, before])).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'missing-history' }],
      })

      const after = await foreign.observe(pr, fixture.record, version)
      expect(hasObservedRecordPin([after], foreign.ref)).toBe(true)
      expect(projectRecoveryHistories([fixture.home, after])).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'missing-history' }],
      })
    },
  )

  it.each(['close-predecision', 'adopt-decision'] as const)(
    'refuses a framed %s record with a changed confirmation digest',
    async (phase) => {
      const fixture = await historicalRecoveryFixture(phase)
      const changed = required(
        parseRecord({
          ...fixture.record,
          payload: {
            ...fixture.record.payload,
            confirmation: { ...fixture.record.payload.confirmation, proposalDigest: '2'.repeat(64) },
          },
        }),
      )
      if (changed.kind !== 'fix-recovery') throw new Error('Expected a framed recovery control')
      const pr = fixture.readBack(changed)
      expect(operation(pr, changed.recordId)?.record).toEqual(changed)

      expect(projectRecoveryHistories([fixture.home, pr])).toEqual({
        ok: false,
        diagnostics: [
          { code: 'unconfirmed', message: 'Recovery proposal or confirmation preimage does not match its control' },
        ],
      })
    },
  )

  it('refuses adoption when its historical observation contains execution evidence for the selected decision', async () => {
    const fixture = await historicalRecoveryFixture('adopt-decision', true)
    const pr = fixture.readBack()
    if (!fixture.evidence) throw new Error('Expected a framed correction result')
    expect(operation(pr, fixture.evidence.recordId)?.record).toEqual(fixture.evidence)

    expect(projectRecoveryHistories([fixture.home, pr])).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'unconfirmed',
          message: 'Correction adoption: request or decision has spent or ambiguous correction evidence',
        },
      ],
    })
  })
})
