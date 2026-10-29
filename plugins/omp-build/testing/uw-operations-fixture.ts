import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { calculateTier } from '../../issue-triage/skills/shared/domain/complexity.ts'
import type {
  IssueRef,
  IssueWriteObservation,
  IssueWritePorts,
} from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { createIssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import { prepareSpecAllocation, type SpecIdentityLedger } from '../engine/uw-identity.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import type { UwRead } from '../roxabi/uw-contract.ts'
import { createUwOperations, type IdentityPublicationResult, type UwOperationsPorts } from '../roxabi/uw-operations.ts'
import { consultableProtocolOptions } from './protocol-retention.unit.ts'
import { allocationRef, CREATED, CREATED_UW, ISSUE, SOURCE_BODY, UW } from './uw-operations-fixture-input.ts'

export type { MutablePlanWrites } from './uw-operations-fixture-input.ts'
export {
  allocationRef,
  CREATED_UW,
  createInput,
  ISSUE,
  identityFailure,
  input,
  planWrites,
  SOURCE_BODY,
  UW,
  WRITES,
} from './uw-operations-fixture-input.ts'

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

export function fixture(
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
    body: SOURCE_BODY,
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
    localProtocolOptions: consultableProtocolOptions(),
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
        parsed: parseIssueSpecBody({ uw: UW, raw: rawSource(UW.target, state.body, state.updatedAt) }),
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
