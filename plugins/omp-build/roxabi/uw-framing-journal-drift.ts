import type { IssueRef, IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { reconstructFramingRegistry, sameScope } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwRead } from './uw-contract.ts'
import {
  ancestryDiagnostics,
  type FramingMemberRun,
  type FramingRunState,
  nativeDiagnostic,
  sameRecordRef,
} from './uw-framing-executor-check.ts'
import { observation } from './uw-operation-observation.ts'

function refKeys(values: readonly IssueRef[]): string {
  return values
    .map((value) => `${value.repository}#${value.number}`)
    .sort()
    .join('\u0000')
}

/** The writer's asserted facts: unordered relation and label sets, never descriptive `updatedAt`. */
export function sameAssertedFacts(left: IssueWriteObservation, right: IssueWriteObservation): boolean {
  return (
    left.issue.repository === right.issue.repository &&
    left.issue.number === right.issue.number &&
    left.title === right.title &&
    left.body === right.body &&
    left.nativeState.state === right.nativeState.state &&
    left.nativeState.stateReason === right.nativeState.stateReason &&
    [...left.labels].sort().join('\u0000') === [...right.labels].sort().join('\u0000') &&
    refKeys(left.parent === null ? [] : [left.parent]) === refKeys(right.parent === null ? [] : [right.parent]) &&
    refKeys(left.children) === refKeys(right.children) &&
    refKeys(left.blockers) === refKeys(right.blockers)
  )
}
type ExpectedMembership = 'none' | 'framing-binding-unregistered' | 'framing-aggregate-incomplete'

function expectedMembership(state: FramingRunState, run: FramingMemberRun): ExpectedMembership {
  if (state.intent === null) return 'none'
  if (run.claim !== null) return 'framing-aggregate-incomplete'
  if (run.planned.key === state.proposal.input.root || run.binding !== null) return 'framing-binding-unregistered'
  return 'none'
}

function registryDiagnostics(state: FramingRunState, uw: Scope, read: UwRead): readonly UwDiagnostic[] {
  const intent = state.intent
  if (intent === null) return []
  const roots = read.histories.filter((history) => sameScope(history.source.scope, intent.scope))
  if (roots.length !== 1)
    return [
      nativeDiagnostic(uw, 'framing-aggregate-unreadable', 'The aggregate registry is not part of this complete cut'),
    ]
  const registry = reconstructFramingRegistry(roots[0], intent)
  if (!registry.ok) return registry.diagnostics
  const claimed = [...state.members.values()].filter((member) => member.claim !== null)
  const drift =
    registry.value.result !== null ||
    registry.value.claims.size !== claimed.length ||
    claimed.some((member) => {
      const claim = registry.value.claims.get(member.planned.key)
      return (
        claim === undefined ||
        member.scope === null ||
        !sameRecordRef(claim.claim, member.claim) ||
        !sameScope(claim.scope, member.scope) ||
        !sameRecordRef(claim.binding, member.binding ?? member.claim)
      )
    })
  return drift
    ? [nativeDiagnostic(uw, 'framing-registry-drift', 'The aggregate registry differs from the confirmed journal')]
    : []
}

function historyDrift(uw: Scope, read: UwRead, run: FramingMemberRun): readonly UwDiagnostic[] | null {
  const own = read.histories.filter((history) => sameScope(history.source.scope, uw))
  const history = own[0]
  if (
    own.length !== 1 ||
    !history.source.complete ||
    history.source.diagnostics.length > 0 ||
    history.diagnostics.length > 0
  )
    return [nativeDiagnostic(uw, 'framing-history-incomplete', 'A unique complete own history is required')]
  const records = history.operations
    .filter((operation) => operation.authority !== 'foreign')
    .map((operation) =>
      operation.status === 'complete' && operation.record !== null ? operation.record.recordId : null,
    )
  if (
    records.includes(null) ||
    records.length !== run.records.length ||
    [...records].sort().join('\u0000') !== [...run.records].sort().join('\u0000')
  )
    return [nativeDiagnostic(uw, 'framing-history-drift', 'Own workflow records differ from the confirmed journal')]
  return null
}

function membershipMatches(state: FramingRunState, run: FramingMemberRun, read: UwRead): boolean {
  const expected = expectedMembership(state, run)
  const membership = read.admission.aggregate
  if (expected === 'none') return membership.status === 'none'
  return (
    membership.status === 'held' &&
    membership.code === expected &&
    membership.member === run.planned.key &&
    sameRecordRef(membership.intent, state.intent)
  )
}

/** The root after its intent and every bound member are registered in the aggregate registry. */
function registered(state: FramingRunState, run: FramingMemberRun): boolean {
  return state.intent !== null && (run.binding !== null || run.planned.key === state.proposal.input.root)
}

/**
 * Compare one fresh complete read with the exact expected prefix: native facts,
 * own history records, absent acceptance, identity head, the aggregate hold, the
 * registry claims, and authenticated inheritance. No self-operation is admitted
 * beyond what the journal confirmed.
 */
export async function memberDrift(
  state: FramingRunState,
  run: FramingMemberRun,
  read: UwRead,
): Promise<readonly UwDiagnostic[]> {
  const uw = run.scope
  if (uw === null) return []
  const fail = (code: string, text: string): readonly UwDiagnostic[] => [nativeDiagnostic(uw, code, text)]
  if (!sameScope(read.uw, uw) || read.observation.status !== 'complete' || read.graph.status !== 'complete')
    return fail('framing-observation-incomplete', 'A complete native and workflow observation is required')
  const native = observation(read)
  if (native === null || run.native === null || !sameAssertedFacts(native, run.native))
    return fail('framing-native-drift', 'Native facts differ from the confirmed journal')
  const history = historyDrift(uw, read, run)
  if (history !== null) return history
  if (read.accepted.status !== 'absent')
    return fail('framing-accepted-present', 'A framing member must have no accepted authority')
  if (!read.identity.ok || !sameRecordRef(read.identity.value.head, run.head))
    return fail('framing-identity-drift', 'Identity ledger head differs from the confirmed journal')
  if (!membershipMatches(state, run, read))
    return fail('framing-membership-drift', 'Aggregate membership differs from the confirmed journal')
  const registry = registered(state, run) ? registryDiagnostics(state, uw, read) : []
  if (registry.length > 0) return registry
  return ancestryDiagnostics(run.planned, run.ancestry, uw, read)
}
