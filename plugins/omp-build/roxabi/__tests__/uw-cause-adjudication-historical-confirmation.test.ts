import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { expect, it } from 'vitest'
import { readComposedWorkflowHistory } from '../../dist/contracts.js'
import { recordsOf } from '../../engine/workflow-control.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { operatorDialogUi } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { createCauseAdjudication } from '../uw-cause-adjudication.ts'
import { historicalWorld } from './uw-cause-adjudication-historical-fixture.ts'

it('confirms and persists a final successor to an unresolved Spec A hold after Spec B is accepted', async () => {
  const world = await historicalWorld(true)
  expect(world.acceptedA.ref.version).not.toEqual(world.acceptedB.ref.version)
  expect(world.pending.payload.outcome.state).toBe('pending-blocking')
  const current = await world.reader.readUw(world.uw)
  expect(current.accepted.status).toBe('accepted')
  if (current.accepted.status !== 'accepted') throw new Error('Reader did not accept Spec B')
  expect(current.accepted.value).toEqual(world.acceptedB)
  const result = await world.adjudicate(world.request)
  expect(result.status, JSON.stringify(result)).toBe('adjudicated')
  if (result.status !== 'adjudicated') throw new Error('Adjudication did not complete')
  expect(world.prompts).toHaveLength(1)
  expect(world.prompts[0]).toContain('adjudicate-cause')
  expect(world.prompts[0]).toContain('historical-pending')
  const loaded = await readComposedWorkflowHistory([world.uw], world.github)
  expect(loaded.ok, JSON.stringify(loaded)).toBe(true)
  if (!loaded.ok || !loaded.histories[0]) throw new Error('Published history unavailable')
  const records = recordsOf(loaded.histories[0])
  const operation = records.find(
    (record) => record.kind === 'cause-operation' && record.payload.proposal.operation === 'adjudicate-cause',
  )
  if (operation?.kind !== 'cause-operation' || operation.payload.proposal.operation !== 'adjudicate-cause')
    throw new Error('Published intent unavailable')
  expect(operation.payload.proposal.pending).toEqual(world.ref)
  expect(operation.payload.confirmation).toMatchObject({
    route: 'omp-native-command',
    operationId: operation.payload.proposal.operationId,
    proposalDigest: operation.payload.proposalDigest,
  })
  const successor = records.find(
    (record) => record.kind === 'cause-disposition' && record.recordId === result.disposition.recordId,
  )
  if (successor?.kind !== 'cause-disposition') throw new Error('Published successor unavailable')
  expect(successor.payload.previous).toEqual(world.ref)
  expect(successor.payload.adjudication).toEqual({
    scope: world.uw,
    recordId: operation.recordId,
    kind: 'cause-operation',
  })
  expect(successor.payload.outcome).toMatchObject({ state: 'final', disposition: 'report', blocking: false })
})

it('does not publish the historical adjudication when the operator declines', async () => {
  const world = await historicalWorld(false)
  const result = await world.adjudicate(world.request)
  expect(result.status, JSON.stringify(result)).toBe('refused')
  expect(world.prompts).toHaveLength(1)
  expect(world.posts).toEqual([])
})

it('rejects an adjudication without cited evidence before confirmation', async () => {
  const world = await historicalWorld(true)
  const result = await world.adjudicate({ ...world.request, references: [] })
  expect(result.status, JSON.stringify(result)).toBe('refused')
  expect(world.prompts).toEqual([])
  expect(world.posts).toEqual([])
})

it('refuses the first confirmed proposal when a competing adjudication advances the pending head during confirmation', async () => {
  let beforeConfirmation: () => Promise<void> = async () => {
    throw new Error('Competing adjudication callback was not installed')
  }
  const world = await historicalWorld(true, () => beforeConfirmation())
  let competingPrompts = 0
  let postsAfterCompetitor = 0
  let competingDisposition: string | undefined
  beforeConfirmation = async () => {
    const operator = createOperatorConfirmation({
      agent: { kind: 'main', depth: 0 },
      hasUI: true,
      mode: 'tui',
      ui: operatorDialogUi(async () => {
        competingPrompts += 1
        return 'confirm'
      }),
      localProtocolOptions: consultableProtocolOptions(),
    } as unknown as ExtensionContext)
    const competitor = createCauseAdjudication({ reader: world.reader, github: world.github, operator })
    const result = await competitor({
      ...world.request,
      reason: 'An independent operator resolves the pending findings first',
    })
    expect(result.status, JSON.stringify(result)).toBe('adjudicated')
    if (result.status !== 'adjudicated') throw new Error('Competing adjudication did not complete')
    competingDisposition = result.disposition.recordId
    postsAfterCompetitor = world.posts.length
  }
  const first = await world.adjudicate(world.request)
  expect(first.status, JSON.stringify(first)).toBe('refused')
  expect(world.prompts).toHaveLength(1)
  expect(competingPrompts).toBe(1)
  expect(world.posts).toHaveLength(postsAfterCompetitor)
  const loaded = await readComposedWorkflowHistory([world.uw], world.github)
  expect(loaded.ok, JSON.stringify(loaded)).toBe(true)
  if (!loaded.ok || !loaded.histories[0]) throw new Error('Published history unavailable')
  const records = recordsOf(loaded.histories[0])
  const operations = records.filter(
    (record) => record.kind === 'cause-operation' && record.payload.proposal.operation === 'adjudicate-cause',
  )
  expect(operations).toHaveLength(1)
  const successors = records.filter(
    (record) => record.kind === 'cause-disposition' && record.payload.previous?.recordId === world.ref.recordId,
  )
  expect(successors).toHaveLength(1)
  expect(successors[0]?.recordId).toBe(competingDisposition)
})
