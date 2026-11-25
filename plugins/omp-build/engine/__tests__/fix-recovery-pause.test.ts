import { expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { discoverFixRecovery } from '../fix-recovery-discovery.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { recoveryAssociationFixture } from './fix-recovery-association-fixture.ts'
import { associationFrames } from './fix-recovery-association-source.ts'
import { pauseControls } from './workflow-test-support.ts'

it('does not gate recovery on historical pause or resume controls', async () => {
  const fixture = await recoveryAssociationFixture()
  const observed = fixture.observe()
  const initial = discoverFixRecovery(observed.input)
  expect(initial).toMatchObject({ status: 'interrupted', phase: { kind: 'request-before-decision' } })
  if (initial.status !== 'interrupted') throw new Error('fixture has no close-eligible owner')
  const controls = pauseControls(fixture.leaf.mandate, 'recovery-pause')
  const frame = associationFrames()
  const inputWith = (records: CanonicalRecord[]) => ({
    ...observed.input,
    histories: observed.input.histories.map((history) =>
      history.source.scope.target === observed.input.uw.target
        ? decodeHistory({
            ...history.source,
            comments: [
              ...history.source.comments,
              ...records.flatMap((record) => frame(record).map((part) => part.comment)),
            ],
          })
        : history,
    ),
  })
  const requested = inputWith([controls.requested])
  const paused = inputWith([controls.requested, controls.confirmed])
  const resumed = inputWith([controls.requested, controls.confirmed, controls.resumed])
  for (const input of [requested, paused, resumed]) {
    expect(discoverFixRecovery(input)).toMatchObject({
      status: 'interrupted',
      phase: { kind: 'request-before-decision' },
    })
  }
})
