import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { calculateTier } from '../../../issue-triage/skills/shared/domain/complexity.ts'
import type {
  IssueRef,
  IssueWriteObservation,
  IssueWritePorts,
} from '../../../issue-triage/skills/shared/domain/issue-write.ts'
import { createIssueWriter } from '../../../issue-triage/skills/shared/domain/issue-write.ts'
import { renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import type { ExternalRecordRef } from '../../engine/record-references.ts'
import type { Scope } from '../../engine/record-values.ts'
import { prepareSpecAllocation, type SpecIdentityLedger } from '../../engine/uw-identity.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import type { UwCreateInput, UwProposalInput, UwRead } from '../uw-contract.ts'
import { createUwOperations, type IdentityPublicationResult, type UwOperationsPorts } from '../uw-operations.ts'
import { UwGraphUnavailableError } from '../uw-read-port.ts'

const UW: Scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
const ISSUE = { repository: UW.repository, number: 42 }
const CREATED = { repository: UW.repository, number: 99 }
const CREATED_UW: Scope = { repository: UW.repository, target: `${UW.repository}#${CREATED.number}` }
const FACTORS = { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 }
const WRITES = {
  labels: { add: [], remove: [] },
  relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
}

type MutablePlanWrites = {
  labels: { add: string[]; remove: string[] }
  relations: {
    addChildren: IssueRef[]
    removeChildren: IssueRef[]
    addBlockers: IssueRef[]
    removeBlockers: IssueRef[]
  }
}

function planWrites(): MutablePlanWrites {
  return {
    labels: { add: ['domain:billing'], remove: [] },
    relations: {
      addChildren: [{ repository: UW.repository, number: 43 }],
      removeChildren: [],
      addBlockers: [],
      removeBlockers: [],
    },
  }
}

function identityFailure(status: 'refused' | 'partial' | 'uncertain'): IdentityPublicationResult {
  return {
    status,
    diagnostics: [
      {
        code: `identity-${status}`,
        message: `Identity publication ${status}`,
        location: { kind: 'native', uw: UW, connection: 'state' },
        related: [],
      },
    ],
  }
}

function input(draftKey: string, statement: string): UwProposalInput {
  return {
    uw: UW,
    title: 'Normalize the current UW',
    draft: {
      criteria: [{ kind: 'new', draftKey, statement }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    },
    factors: FACTORS,
    writes: WRITES,
    normalization: [],
    tierOverride: null,
  }
}
function createInput(): UwCreateInput {
  const { uw: _uw, ...request } = input('unused', 'Unused')
  return {
    ...request,
    repository: UW.repository,
    draft: {
      criteria: [],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    },
  }
}

type State = {
  title: string
  body: string
  labels: string[]
  children: IssueRef[]
  updatedAt: string
  ledger: SpecIdentityLedger
  acceptedSource: ExternalRecordRef | null
  acceptedRefused: boolean
  conflictOnPatch: boolean
  published: ExternalRecordRef[]
  patchCount: number
  readScopes: Scope[]
  issueReadIssues: IssueRef[]
  identityScopes: Scope[]
  patchedIssues: IssueRef[]
}

function allocationRef(recordId: string): ExternalRecordRef {
  return { scope: UW, recordId, kind: 'spec-identity' }
}

function acceptedResult(source: ExternalRecordRef | null, refused = false): UwRead['accepted'] {
  if (refused)
    return {
      status: 'refused',
      diagnostics: [
        {
          code: 'accepted-unreadable',
          message: 'Accepted chain is unreadable',
          location: { kind: 'native', uw: UW, connection: 'state' },
          related: [],
        },
      ],
    }
  if (source === null) return { status: 'absent' }
  return {
    status: 'accepted',
    value: {
      ref: { uw: UW, version: 'a'.repeat(64), sourceAccepted: source },
    },
  } as UwRead['accepted']
}

function observation(state: State): IssueWriteObservation {
  return {
    issue: ISSUE,
    title: state.title,
    body: state.body,
    updatedAt: state.updatedAt,
    labels: [...state.labels],
    parent: null,
    children: [...state.children],
    blockers: [],
  }
}

function fixture(
  options: {
    onConfirm?: (state: State) => void
    conflictOnPatch?: boolean
    readBarrier?: Promise<void>
    publishIdentityResult?: IdentityPublicationResult
    acceptedRefused?: boolean
    postEffectReadFailure?: Error
  } = {},
) {
  const state: State = {
    title: 'Current UW framing',
    body: 'Current issue body',
    labels: [],
    children: [],
    updatedAt: '2026-10-27T12:00:00.000Z',
    ledger: {
      uw: UW,
      head: null,
      nextCriterion: '1',
      nextInvariant: '1',
      allocations: new Map(),
      retired: new Map(),
    },
    acceptedSource: null,
    acceptedRefused: options.acceptedRefused ?? false,
    conflictOnPatch: options.conflictOnPatch ?? false,
    published: [],
    patchCount: 0,
    readScopes: [],
    issueReadIssues: [],
    identityScopes: [],
    patchedIssues: [],
  }
  const issuePorts: IssueWritePorts = {
    read: async (issue) => {
      state.issueReadIssues.push({ ...issue })
      if (
        (issue.repository === ISSUE.repository && issue.number === ISSUE.number) ||
        (issue.repository === CREATED.repository && issue.number === CREATED.number)
      )
        return { ...observation(state), issue }
      return {
        issue,
        title: 'Referenced UW',
        body: '',
        updatedAt: state.updatedAt,
        labels: [],
        parent: null,
        children: [],
        blockers: [],
      }
    },
    create: async () => CREATED,
    patch: async (issue, value) => {
      state.patchCount += 1
      state.patchedIssues.push({ ...issue })
      state.title = value.title ?? state.title
      state.body = state.conflictOnPatch ? 'Remote body won the race' : value.body
      state.updatedAt = '2026-10-27T12:02:00.000Z'
    },
    updateLabels: async (_issue, value) => {
      const labels = new Set(state.labels)
      for (const label of value.remove) labels.delete(label)
      for (const label of value.add) labels.add(label)
      state.labels = [...labels]
    },
    addChild: async (parent, child) => {
      if (parent.repository === ISSUE.repository && parent.number === ISSUE.number) state.children.push({ ...child })
    },
    removeChild: async () => undefined,
    addBlocker: async () => undefined,
    removeBlocker: async () => undefined,
  }
  const operator = createOperatorConfirmation({
    agent: { kind: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    ui: {
      confirm: async () => {
        options.onConfirm?.(state)
        return true
      },
    },
  } as unknown as ExtensionContext)
  const ports: UwOperationsPorts = {
    read: async (uw) => {
      state.readScopes.push(structuredClone(uw))
      await options.readBarrier
      if (state.patchCount > 0 && options.postEffectReadFailure !== undefined) throw options.postEffectReadFailure
      return {
        uw: UW,
        graph: {
          status: 'complete',
          root: UW,
          observedAt: state.updatedAt,
          nodes: [
            {
              uw: UW,
              title: state.title,
              raw: {
                reference: UW.target,
                body: state.body,
                bodySha256: 'b'.repeat(64),
                lastEditedAt: state.updatedAt,
              },
              updatedAt: state.updatedAt,
              labels: [...state.labels],
              wayfinderLabels: [],
              parent: null,
              children: [],
              blockers: [],
              native: { state: 'OPEN', stateReason: null },
            },
          ],
        },
        identity: { ok: true, value: state.ledger },
        accepted: acceptedResult(state.acceptedSource, state.acceptedRefused),
        parsed: {} as never,
        proposed: {} as never,
        admission: {} as never,
      } as UwRead
    },
    writer: createIssueWriter(issuePorts),
    operator,
    prepareSpecAllocation,
    renderIssueSpecBody,
    calculateTier,
    parseNormalization: () => ({ ok: false, diagnostics: [] }),
    publishIdentity: async ({ uw, proposal }) => {
      state.identityScopes.push(structuredClone(uw))
      if (options.publishIdentityResult?.status === 'refused') return options.publishIdentityResult
      const ref = allocationRef(`identity-${state.published.length + 1}`)
      const allocations = new Map(state.ledger.allocations)
      for (const assignment of proposal.proposal.allocation.assignments) allocations.set(assignment.id, ref)
      const criterionAllocations = proposal.proposal.allocation.assignments.filter((assignment) =>
        assignment.id.startsWith('C'),
      )
      const invariantAllocations = proposal.proposal.allocation.assignments.filter((assignment) =>
        assignment.id.startsWith('I'),
      )
      state.ledger = {
        ...state.ledger,
        head: ref,
        nextCriterion: (BigInt(state.ledger.nextCriterion) + BigInt(criterionAllocations.length)).toString(),
        nextInvariant: (BigInt(state.ledger.nextInvariant) + BigInt(invariantAllocations.length)).toString(),
        allocations,
      }
      state.published.push(ref)
      state.updatedAt = '2026-10-27T12:01:00.000Z'
      return options.publishIdentityResult ?? { status: 'confirmed' }
    },
    acceptMaterial: async () => ({ status: 'refused', diagnostics: [] }),
    scopeOf: (issue) => (issue.number === CREATED.number ? CREATED_UW : UW),
  }
  return { state, operations: createUwOperations(ports) }
}

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
