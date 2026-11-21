import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { calculateTier } from '../../issue-triage/skills/shared/domain/complexity.ts'
import type { IssueWriteObservation, IssueWritePorts } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { createIssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { resolveSpecEffective } from '../engine/spec-effective.ts'
import { prepareSpecAllocation } from '../engine/uw-identity.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { guardedCauseWriter } from '../roxabi/uw-cause-guard.ts'
import { createUwOperations, type IdentityPublicationResult, type UwOperationsPorts } from '../roxabi/uw-operations.ts'
import { operatorDialogUi, operatorRootContext } from './operator-dialog-ui.ts'
import { consultableProtocolOptions } from './protocol-retention.unit.ts'
import { allocationRef, CREATED, CREATED_UW, ISSUE, SOURCE_BODY, UW } from './uw-operations-fixture-input.ts'
import { readFixtureUw, type State } from './uw-operations-fixture-read.ts'

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

function observation(state: State): IssueWriteObservation {
  return {
    issue: ISSUE,
    title: state.title,
    body: state.body,
    updatedAt: state.updatedAt,
    nativeState: { ...state.nativeState },
    labels: [...state.labels],
    parent: null,
    children: [...state.children],
    blockers: [],
  }
}

export function fixture(
  options: {
    onConfirm?: (state: State) => void
    confirm?: boolean
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
    nativeState: { state: 'OPEN', stateReason: null },
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
  let created = false
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
        nativeState: { state: 'OPEN', stateReason: null },
        labels: [],
        parent: null,
        children: [],
        blockers: [],
      }
    },
    create: async ({ title, body }) => {
      created = true
      state.title = title
      state.body = body
      state.labels = []
      state.children = []
      return CREATED
    },
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
    setNativeState: async (_issue, effect) => {
      state.nativeState = effect
    },
  }
  const operator = createOperatorConfirmation({
    ...operatorRootContext('/fixture', consultableProtocolOptions()),
    hasUI: true,
    mode: 'tui',
    ui: operatorDialogUi(async () => {
      options.onConfirm?.(state)
      return (options.confirm ?? true) ? 'confirm' : 'refuse'
    }),
  } as unknown as ExtensionContext)
  const ports: UwOperationsPorts = {
    readCreated: async (uw) => {
      const { parsed, proposed, identity, histories, graph } = await ports.read(uw)
      return { uw, parsed, proposed, identity, histories, graph }
    },
    resolveInterruption: async () => {
      throw new Error('unexpected interruption resolution')
    },
    abandon: async () => {
      throw new Error('unexpected abandonment')
    },
    adjustCauseDependency: async () => {
      throw new Error('unexpected adjustment')
    },
    read: async (uw) => {
      state.readScopes.push(structuredClone(uw))
      await options.readBarrier
      if (
        (state.patchCount > 0 || (created && uw.target === CREATED_UW.target)) &&
        options.postEffectReadFailure !== undefined
      )
        throw options.postEffectReadFailure
      return readFixtureUw(state)
    },
    listReports: async (root) => ({ ok: true, value: { root, reports: [] } }),
    guardParent: async () => {},
    writer: createIssueWriter(issuePorts),
    guardedWriter: (beforeEffect) => guardedCauseWriter(issuePorts, createIssueWriter, beforeEffect),
    causeOperations: () => ({
      adjudicateCause: async () => {
        throw new Error('unexpected adjudication')
      },
      createSister: async () => {
        throw new Error('unexpected sister')
      },
      promoteReport: async () => {
        throw new Error('unexpected promotion')
      },
    }),
    operator,
    prepareSpecAllocation,
    resolveSpecEffective,
    renderIssueSpecBody,
    calculateTier,
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
    closeLinked: async () => {
      throw new Error('unexpected close-linked effect')
    },
    scopeOf: (issue) => (issue.number === CREATED.number ? CREATED_UW : UW),
  }
  return { state, ports, operations: createUwOperations(ports) }
}
