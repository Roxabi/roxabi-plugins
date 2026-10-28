import { describe, expect, it } from 'vitest'
import {
  allocationRef,
  CREATED_UW,
  createInput,
  fixture,
  ISSUE,
  identityFailure,
  input,
  type MutablePlanWrites,
  planWrites,
  SOURCE_BODY,
  UW,
  WRITES,
} from '../../testing/uw-operations-fixture.ts'
import type { UwProposalInput } from '../uw-contract.ts'
import { UwGraphUnavailableError } from '../uw-read-port.ts'

describe('UW operation write authority', () => {
  it('writes after its confirmed allocation advances the ledger even though only updatedAt changed', async () => {
    const { operations, state } = fixture()

    await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      status: 'written',
    })

    expect(state.published).toHaveLength(1)
    expect(state.ledger.head).toEqual(state.published[0])
    expect(state.ledger.allocations.get('C1')).toEqual(state.published[0])
    expect(state.ledger.nextCriterion).toBe('2')
    expect(state.patchCount).toBe(1)
  })

  it('refuses preparation when the observed source differs from the bound source', async () => {
    const { operations, state } = fixture()
    state.body = `${SOURCE_BODY}changed`

    await expect(operations.prepare(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: 'normalization-source-stale' }],
    })

    expect(state.published).toEqual([])
    expect(state.patchCount).toBe(0)
  })

  it('refuses before identity publication when the source changes during confirmation', async () => {
    const { operations, state } = fixture({
      onConfirm: (current) => {
        current.body = `${SOURCE_BODY}changed`
      },
    })

    await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'normalization-source-stale' }],
    })

    expect(state.published).toEqual([])
    expect(state.patchCount).toBe(0)
  })

  it('refuses a cross-repository parent for existing and create UW preparation', async () => {
    const { operations, state } = fixture()
    const crossRepositoryParent = { repository: 'acme/planning', number: 41 }
    const existing = {
      ...input('first', 'Keep payments auditable'),
      writes: {
        ...WRITES,
        relations: {
          ...WRITES.relations,
          parent: crossRepositoryParent,
        },
      },
    }
    const creation = {
      ...createInput(),
      writes: {
        ...WRITES,
        relations: {
          ...WRITES.relations,
          parent: crossRepositoryParent,
        },
      },
    }

    await expect(operations.prepare(existing)).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: 'cross-repository-parent' }],
    })
    await expect(operations.create(creation)).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'cross-repository-parent' }],
    })

    expect(state.published).toEqual([])
    expect(state.patchCount).toBe(0)
  })

  it('refuses a public write that omits accounting for the current legacy criterion', async () => {
    const { operations, state } = fixture()
    state.body = '# Acceptance Criteria\n- Preserve the customer audit trail'
    const request = {
      ...input('first', 'Keep payments auditable', state.body),
      normalization: [],
    }

    const result = await operations.write(request)
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') throw new Error('Expected source conservation refusal')
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('normalization-source-unaccounted')

    expect(state.published).toEqual([])
    expect(state.patchCount).toBe(0)
  })

  it('refuses without patching when identity publication is refused', async () => {
    const { operations, state } = fixture({ publishIdentityResult: identityFailure('refused') })

    await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'identity-refused' }],
    })

    expect(state.published).toEqual([])
    expect(state.patchCount).toBe(0)
    expect(state.issueReadIssues).toEqual([])
  })

  for (const status of ['partial', 'uncertain'] as const) {
    it(`returns partial without patching after durable ${status} identity publication`, async () => {
      const { operations, state } = fixture({ publishIdentityResult: identityFailure(status) })

      await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
        status: 'partial',
        uw: UW,
        diagnostics: [{ code: `identity-${status}` }],
      })

      expect(state.published).toHaveLength(1)
      expect(state.patchCount).toBe(0)
      expect(state.issueReadIssues).toEqual([])
    })
  }

  it('refuses before publication when another allocation advances the ledger during confirmation', async () => {
    const { operations, state } = fixture({
      onConfirm: (current) => {
        current.ledger = { ...current.ledger, head: allocationRef('other-allocation'), nextCriterion: '2' }
      },
    })

    await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'proposal-stale' }],
    })

    expect(state.published).toEqual([])
    expect(state.patchCount).toBe(0)
  })

  it('refuses before publication when the accepted predecessor changes during confirmation', async () => {
    const { operations, state } = fixture({
      onConfirm: (current) => {
        current.acceptedSource = { scope: UW, recordId: 'accepted-successor', kind: 'operator-control' }
      },
    })

    await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'proposal-stale' }],
    })

    expect(state.published).toEqual([])
    expect(state.patchCount).toBe(0)
  })

  it('captures the input UW before preparation awaits the native read', async () => {
    const readBarrier = Promise.withResolvers<void>()
    const { operations, state } = fixture({ readBarrier: readBarrier.promise })
    const request = structuredClone(input('first', 'Keep payments auditable'))
    request.uw = { repository: UW.repository, target: UW.target }

    const prepared = operations.prepare(request)
    request.uw = { repository: 'other/widgets', target: 'other/widgets#99' }
    readBarrier.resolve()

    await expect(prepared).resolves.toMatchObject({
      ok: true,
      value: { proposal: { target: { kind: 'existing', uw: UW } } },
    })
    expect(state.readScopes).toEqual([UW])
  })

  it('writes the input UW and nested plan captured before confirmation', async () => {
    let request!: UwProposalInput
    let writes!: MutablePlanWrites
    const { operations, state } = fixture({
      onConfirm: () => {
        request.uw = { repository: 'other/widgets', target: 'other/widgets#99' }
        writes.labels.add.push('domain:forged')
        const child = writes.relations.addChildren[0]
        if (child === undefined) throw new Error('expected child relation')
        child.number = 99
      },
    })
    request = structuredClone(input('first', 'Keep payments auditable'))
    request.uw = { repository: UW.repository, target: UW.target }
    writes = planWrites()
    request.writes = writes
    request.tierOverride = { tier: 'F-lite', reason: 'Customer migration' }

    await expect(operations.write(request)).resolves.toMatchObject({ status: 'written' })

    expect(state.readScopes).toEqual([UW, UW, UW])
    expect(state.identityScopes).toEqual([UW])
    expect(state.patchedIssues).toEqual([ISSUE])
    expect(state.labels).toEqual(['domain:billing', 'size:F-lite'])
    expect(state.children).toEqual([{ repository: UW.repository, number: 43 }])
  })

  it('reports a post-allocation body conflict as partial and does not reuse the reserved identity', async () => {
    const { operations, state } = fixture({ conflictOnPatch: true })

    await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      status: 'partial',
      uw: UW,
      diagnostics: [{ code: 'write-conflict' }],
    })

    expect(state.ledger.allocations.has('C1')).toBe(true)
    state.body = SOURCE_BODY
    await expect(operations.prepare(input('second', 'Keep payment history available'))).resolves.toMatchObject({
      ok: true,
      value: { proposal: { allocation: { assignments: [{ draftKey: 'second', id: 'C2' }] } } },
    })
  })
  it('does not retire an accepted identity when a later proposal omits it', async () => {
    const { operations, state } = fixture()
    const allocated = allocationRef('identity-c1')
    state.ledger = {
      ...state.ledger,
      head: allocated,
      nextCriterion: '2',
      allocations: new Map([['C1', allocated]]),
    }
    state.acceptedSource = { scope: UW, recordId: 'accepted-c1', kind: 'operator-control' }
    const request = {
      ...input('replacement', 'Not used'),
      normalization: [],
      draft: {
        criteria: [],
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
    }

    await expect(operations.write(request)).resolves.toMatchObject({ status: 'written' })

    expect(state.identityScopes).toEqual([])
    expect(state.ledger.retired.has('C1')).toBe(false)
  })
  it('refuses without identity or body effects when the accepted chain is unreadable', async () => {
    const { operations, state } = fixture({ acceptedRefused: true })

    await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'accepted-unreadable' }],
    })

    expect(state.identityScopes).toEqual([])
    expect(state.patchCount).toBe(0)
  })

  it('refuses before identity publication when the accepted chain becomes unreadable', async () => {
    const { operations, state } = fixture({
      onConfirm: (current) => {
        current.acceptedRefused = true
      },
    })

    await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'proposal-stale' }],
    })

    expect(state.identityScopes).toEqual([])
    expect(state.patchCount).toBe(0)
  })
  it('preserves graph diagnostics after a written UW cannot be read back', async () => {
    const unavailable = new UwGraphUnavailableError([
      {
        code: 'graph-unavailable',
        message: 'Current UW graph is unavailable',
        location: { kind: 'native', uw: UW, connection: 'state' },
        related: [],
      },
    ])
    const { operations, state } = fixture({ postEffectReadFailure: unavailable })

    await expect(operations.write(input('first', 'Keep payments auditable'))).resolves.toMatchObject({
      status: 'partial',
      uw: UW,
      diagnostics: [{ code: 'graph-unavailable', message: 'Current UW graph is unavailable' }],
    })

    expect(state.published).toHaveLength(1)
    expect(state.patchCount).toBe(1)
  })

  it('reports partial after creating an empty-obligation UW cannot be read back', async () => {
    const { operations, state } = fixture({ postEffectReadFailure: new Error('post-create-read-unavailable') })

    await expect(operations.create(createInput())).resolves.toMatchObject({
      status: 'partial',
      uw: CREATED_UW,
      diagnostics: [{ code: 'post-effect-read-failed', message: 'post-create-read-unavailable' }],
    })

    expect(state.identityScopes).toEqual([])
    expect(state.patchCount).toBe(1)
  })
})
