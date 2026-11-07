import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Scope } from '../../engine/record-values.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { dispose } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { numberOf } from '../../testing/framing-runtime-fixture.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'
import { begun, codes, leafInterview, leafProposal, submit } from './feature-framing-controller-drivers.ts'
import {
  questionEntry,
  userEntry,
  type World,
  type WrittenBoundary,
  world,
  writtenBoundary,
} from './feature-framing-controller-world.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})
/** Interview, stage and confirm one Leaf through the real installed publisher; returns the prepared checkout. */
/** A fresh installed read of the native acceptance the real continuation publishes. */
async function acceptance(w: World, boundary: WrittenBoundary, root: Scope) {
  const reader = await createInstalledUwOperations({
    cwd: '/fixture',
    gh: boundary.native.gh,
    readAuthor: 'automation',
    operator: createOperatorConfirmation(w.ctx()),
  })
  return (await reader.readUw(root)).accepted
}

async function framedToMove(w: World): Promise<{ destination: string; root: Scope }> {
  await leafInterview(w)
  expect(codes(await submit(w, leafProposal()))).toEqual(['framing-proposal-staged'])
  w.runtime.idle = true
  w.runtime.answers.push(true)
  await w.controller.act(w.ctx())
  const pending = w.controller.view()?.pendingMove
  if (!pending) throw new Error(`Expected a written aggregate awaiting the human move: ${w.statuses.at(-1)}`)
  expect(w.controller.view()?.phase).toEqual({ kind: 'awaiting-human-move' })
  return pending
}

describe('written framing handoff', () => {
  test('a confirmed frame writes natively, prepares the real checkout and continues exactly once after an attested move', async () => {
    const boundary = writtenBoundary()
    const w = world({ written: boundary })
    const { destination, root } = await framedToMove(w)
    expect(root.repository).toBe('acme/app')
    expect(boundary.native.issues.has(numberOf(root))).toBe(true)
    expect(boundary.native.count('create')).toBe(1)
    expect(existsSync(destination)).toBe(true)
    expect(w.statuses.at(-1)).toContain(`/move ${destination}`)
    const confirmations = w.runtime.confirms

    await w.controller.act(w.ctx())
    expect(w.statuses.at(-1)).toContain('still waiting')
    w.location.cwd = join(boundary.principal, '..')
    await w.controller.act(w.ctx())
    expect(w.statuses.at(-1)).toContain('still waiting')
    expect(w.runtime.confirms).toBe(confirmations)

    w.location.cwd = destination
    w.runtime.answers.push(false)
    await w.controller.act(w.ctx())
    expect(w.statuses.at(-1)).toContain('move not attested')
    expect(w.controller.view()?.phase).toEqual({ kind: 'awaiting-human-move' })
    expect(w.continued).toEqual([])
    expect((await acceptance(w, boundary, root)).status).toBe('absent')

    w.runtime.answers.push(true)
    await w.controller.act(w.ctx())
    expect(w.continued).toEqual([
      expect.objectContaining({
        cwd: destination,
        reference: root.target,
        control: 'continue',
        principal: false,
        parentCoverage: null,
      }),
    ])
    expect(w.statuses.at(-1)).toBe(`feature-framing: continued ${root.target} at ${destination}`)
    expect(w.controller.view()).toBeNull()
    expect(w.outcomes).toHaveLength(1)
    const accepted = await acceptance(w, boundary, root)
    expect(accepted.status, `fresh installed accepted read: ${JSON.stringify(accepted)}`).toBe('accepted')
    const nativeWrites = boundary.native.writes.length

    await w.controller.act(w.ctx())
    expect(w.statuses.at(-1)).toBe('feature-framing: nothing awaits confirmation')
    expect(w.continued).toHaveLength(1)
    expect(w.outcomes).toHaveLength(1)
    expect(boundary.native.writes.length).toBe(nativeWrites)
    expect(boundary.native.count('create')).toBe(1)
  })

  test('a native root changed after the handoff is refused at the destination and never continues', async () => {
    const boundary = writtenBoundary()
    const w = world({ written: boundary })
    const { destination, root } = await framedToMove(w)
    const issue = boundary.native.issues.get(numberOf(root))
    if (!issue) throw new Error('missing native root')
    issue.title = `${issue.title} changed by someone else`
    w.location.cwd = destination
    w.runtime.answers.push(true)
    await w.controller.act(w.ctx())
    expect(w.statuses.at(-1)).toContain('destination refused (framing-handoff-changed)')
    expect((await acceptance(w, boundary, root)).status).toBe('absent')
    expect(w.continued).toEqual([])
    await w.controller.act(w.ctx())
    expect(w.continued).toEqual([])
  })

  test('a procedure supply changed across the move blocks without continuing', async () => {
    const boundary = writtenBoundary()
    const w = world({ written: boundary })
    const { destination, root } = await framedToMove(w)
    w.supply.drift('codebase-design')
    w.location.cwd = destination
    w.runtime.answers.push(true)
    await w.controller.act(w.ctx())
    expect(w.statuses.at(-1)).toContain('procedure supply changed across the move')
    expect((await acceptance(w, boundary, root)).status).toBe('absent')
    expect(w.continued).toEqual([])
  })

  test('cancellation while the handoff reads prevents the checkout and still reports the written root', async () => {
    const boundary = writtenBoundary()
    const w = world({ written: boundary })
    await leafInterview(w)
    expect(codes(await submit(w, leafProposal()))).toEqual(['framing-proposal-staged'])
    w.runtime.idle = true
    w.runtime.answers.push(true)
    w.runtime.onRepoView = () => {
      w.runtime.onRepoView = null
      w.controller.cancel('session-switch')
    }
    await w.controller.act(w.ctx())
    expect(boundary.native.count('create')).toBe(1)
    expect(w.statuses).toContainEqual(
      expect.stringMatching(
        /acme\/app#\d+ written, but framing was cancelled during handoff\..*nothing is rolled back/,
      ),
    )
    expect(existsSync(boundary.checkouts) ? readdirSync(boundary.checkouts) : []).toEqual([])
    expect(w.continued).toEqual([])
    expect(w.controller.view()).toBeNull()
  })

  test('an answered offer frames a tierless Wayfinder natively and closes with no UW handoff, checkout or continuation', async () => {
    const boundary = writtenBoundary()
    const w = world({ written: boundary })
    await begun(w)
    expect(
      (await submit(w, { kind: 'wayfinder-offer', question: 'Map the queue as a Wayfinder first?' }, 'call-wf')).status,
    ).toBe('waiting')
    w.entries.push(questionEntry('q-wf', 'call-wf'), userEntry('u-wf', 'Yes, map it first'))
    const proposal = {
      kind: 'proposal',
      decisions: [{ questionEntryId: 'q-wf', answerEntryId: 'u-wf', decision: 'Map the unknowns before any UW' }],
      vocabulary: [],
      modules: [],
      aggregate: {
        kind: 'wayfinder',
        root: 'map',
        edges: [],
        coverage: [],
        foundations: [],
        members: [
          {
            kind: 'wayfinder',
            slot: { kind: 'new', key: 'map' },
            title: 'Map the request queue',
            body: 'Map the queue unknowns',
            label: 'wayfinder:map',
          },
        ],
      },
    }
    expect(codes(await submit(w, proposal))).toEqual(['framing-proposal-staged'])
    w.runtime.idle = true
    w.runtime.answers.push(false)
    await w.controller.act(w.ctx())
    expect(w.controller.view()?.phase.kind).toBe('interview')
    expect(boundary.native.writes).toEqual([])

    w.runtime.idle = false
    expect(codes(await submit(w, proposal))).toEqual(['framing-proposal-staged'])
    w.runtime.idle = true
    w.runtime.answers.push(true)
    await w.controller.act(w.ctx())
    expect(w.runtime.confirms).toBe(2)
    expect(boundary.native.count('create')).toBe(1)
    const [number, card] = [...boundary.native.issues].at(-1) ?? []
    if (number === undefined || card === undefined) throw new Error('missing native Wayfinder card')
    expect(card.labels).toEqual(['wayfinder:map'])
    expect(w.statuses.at(-1)).toMatch(
      new RegExp(
        `^feature-framing: Wayfinder acme/app#${number} framed, pas d’UW: cards map acme/app#${number}\\. .*No checkout, Mandate or continuation follows\\.`,
      ),
    )
    const reader = await createInstalledUwOperations({
      cwd: '/fixture',
      gh: boundary.native.gh,
      readAuthor: 'automation',
      operator: createOperatorConfirmation(w.ctx()),
    })
    expect(
      (await reader.readUw({ repository: 'acme/app', target: `acme/app#${number}` })).admission.aggregate,
    ).toMatchObject({ status: 'complete' })
    expect(boundary.gitCalls).toEqual([])
    expect(existsSync(boundary.checkouts) ? readdirSync(boundary.checkouts) : []).toEqual([])
    expect(w.continued).toEqual([])
    expect(w.controller.view()).toBeNull()
  })
})
