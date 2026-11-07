import { expect, it } from 'vitest'
import { runCauseAdjustmentScenario } from './uw-cause-adjustment-fixture.ts'

it('withdraws the causal wait only after the confirmed native blocker removal and authenticates its replay', async () => {
  const proof = await runCauseAdjustmentScenario()
  expect(proof.before.observation).toBe('complete')
  expect(proof.before.node?.blockers).toEqual([proof.sister])
  expect(proof.before.wait).toMatchObject({ state: 'required', target: proof.sister, control: null })
  expect(proof.before.dependency?.state).toBe('held')
  expect(proof.result.status, JSON.stringify(proof.result)).toBe('adjusted')
  if (proof.result.status !== 'adjusted') throw new Error('Adjustment was not confirmed')
  expect(proof.confirmations).toHaveLength(1)
  expect(proof.journal.map((entry) => entry.kind)).toEqual(['remove-blocker', 'patch', 'publish'])
  expect(proof.after.observation).toBe('complete')
  expect(proof.after.node?.blockers).toEqual([])
  expect(proof.after.node?.raw.body).toBe(proof.before.node?.raw.body)
  expect(proof.after.node?.title).toBe(proof.before.node?.title)
  expect(proof.after.accepted).toEqual(proof.before.accepted)
  expect(proof.after.wait).toMatchObject({ state: 'withdrawn', control: proof.result.control })
  expect(proof.after.controlRecords).toHaveLength(1)
  expect(proof.canonicalControl).toEqual(proof.after.controlRecords[0])
  expect(proof.canonicalControl).toMatchObject({
    kind: 'operator-control',
    recordId: proof.result.control.recordId,
    payload: {
      control: 'adjust-cause-dependency',
      proposal: {
        disposition: proof.disposition,
        receipt: proof.receipt,
        predecessor: proof.receipt,
        change: { kind: 'withdraw' },
        nativeEffect: { kind: 'update-blockers', remove: [proof.sister], add: [] },
      },
      execution: { observed: { blockers: [] } },
    },
  })
  expect(proof.replay?.node?.blockers).toEqual([proof.sister])
  expect(proof.replay?.wait).toMatchObject({ state: 'withdrawn', control: proof.result.control })
  expect(proof.replay?.requirements).toContainEqual({
    from: proof.origin,
    to: proof.sister,
    source: { kind: 'native-blocker' },
  })
  expect(proof.replay?.dependency?.state).toBe('held')
  expect(proof.replay?.completion?.state).not.toBe('complete')
})

it('declining the native confirmation leaves the graph and causal chain untouched', async () => {
  const proof = await runCauseAdjustmentScenario('decline')
  expect(proof.confirmations).toHaveLength(1)
  expect(proof.result).toMatchObject({
    status: 'refused',
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'operator-confirmation-declined' })]),
  })
  expect(proof.journal).toEqual([])
  expect(proof.after.node?.blockers).toEqual([proof.sister])
  expect(proof.after.wait).toMatchObject({ state: 'required', target: proof.sister, control: null })
  expect(proof.after.dependency?.state).toBe('held')
  expect(proof.after.controlRecords).toEqual([])
})

it('does not publish a terminal control when the native transport loses the confirmed delta', async () => {
  const proof = await runCauseAdjustmentScenario('lost-delta')
  expect(proof.confirmations).toHaveLength(1)
  expect(proof.result).toMatchObject({
    status: 'partial',
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'write-conflict' })]),
  })
  expect(proof.journal.map((entry) => entry.kind)).toEqual(['remove-blocker', 'patch'])
  expect(proof.after.node?.blockers).toEqual([proof.sister])
  expect(proof.after.wait).toMatchObject({ state: 'required', target: proof.sister, control: null })
  expect(proof.after.dependency?.state).toBe('held')
  expect(proof.after.controlRecords).toEqual([])
})
