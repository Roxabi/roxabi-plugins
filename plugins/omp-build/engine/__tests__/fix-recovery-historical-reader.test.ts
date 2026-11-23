import { describe, expect, it } from 'vitest'
import { projectRecoveryHistories } from '../../adapters/github/history-codec.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
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
