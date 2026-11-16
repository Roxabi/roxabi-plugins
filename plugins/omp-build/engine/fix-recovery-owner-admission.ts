import { canonicalValueDigest } from './action-input.ts'
import { assessAdmissionClaim } from './fix-recovery-admission-claim.ts'
import {
  scopeId,
  validateAdmissionDiagnostics,
  validateAdmissionHistories,
} from './fix-recovery-admission-validation.ts'
import type { FixRecoveryNativePreparation } from './fix-recovery-control-schema.ts'
import { discoverSelectedRecoveryOwner } from './fix-recovery-discovery.ts'
import type { ReservedRecordIdentity } from './fix-recovery-identities.ts'
import type { FixRecoveryCurrentFacts } from './fix-recovery-observation.ts'
import type { RecoveryOwnerLineage } from './fix-recovery-owner-lineage.ts'
import { authenticatedLineage } from './fix-recovery-replay.ts'
import type { Destination, LatchNamespace, RecoveryRef } from './fix-recovery-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Scope } from './record-values.ts'
import type { Result } from './result.ts'
import type { UwGraphObservation } from './uw-graph.ts'

const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
type AdmissionInput = {
  uw: Scope
  pullRequest: Scope
  destination: Destination
  graph: UwGraphObservation
  histories: readonly DecodedHistory[]
  effectiveHistories: readonly DecodedHistory[]
  intent: 'fresh' | 'recovery' | 'claim'
  claim?: {
    reservation: ReservedRecordIdentity<'fix-owner'>
    current: FixRecoveryCurrentFacts
    nativePreparation: FixRecoveryNativePreparation
  }
}
type AdmissionResult =
  | { status: 'fresh'; afterClose: RecoveryRef | null; priorNamespace: LatchNamespace | null }
  | {
      status: 'recovery'
      opened: { kind: 'fix-owner'; scope: Scope; recordId: string }
      settled: { kind: 'fix-owner'; scope: Scope; recordId: string }
      priorNamespace: LatchNamespace
    }
  | { status: 'claim'; claimReservation: ReservedRecordIdentity<'fix-owner'>; priorNamespace: LatchNamespace }
/** Re-run under the actual destination lease before publishing any new owner. */
export function assessFixOwnerAdmission(input: AdmissionInput): Result<AdmissionResult> {
  const { histories, effectiveHistories, uw, pullRequest, destination } = input
  const validated = validateAdmissionHistories(histories, effectiveHistories, uw, pullRequest)
  if (!validated.ok) return validated
  const { homes, effective } = validated.value
  const lineage = authenticatedLineage(histories, uw, new Set())
  if (!lineage.ok) return lineage
  const last = lineage.value.links.at(-1)
  const home = homes.get(scopeId(uw))
  if (home === undefined) return fail('Owner admission is missing a required UW or pull-request history')
  const ownerRecords = home.operations.flatMap((operation) =>
    operation.authority !== 'foreign' &&
    operation.status === 'complete' &&
    operation.record?.kind === 'fix-owner' &&
    operation.record.payload.phase === 'opened'
      ? [operation.record]
      : [],
  )
  if (
    ownerRecords.some(
      (owner) =>
        owner.payload.phase === 'opened' &&
        owner.payload.common.writeScopes.some((scope) => !homes.has(scopeId(scope))),
    )
  )
    return fail('Owner lineage lacks an owner write scope')
  if (
    last !== undefined &&
    (!equalScope(last.opening.payload.common.pullRequest, pullRequest) ||
      canonicalValueDigest(last.opening.payload.common.destination) !== canonicalValueDigest(destination))
  )
    return fail('Active owner lineage belongs to another destination or pull request')
  const host = last?.opening.payload.common.host
  const priorNamespace = host?.kind === 'linux-qualified' ? host.namespace : null
  const allowed = new Set<string>()
  if (
    input.intent === 'recovery' &&
    last?.settlement !== null &&
    last?.settlement !== undefined &&
    last.control === null
  )
    for (const entry of last.settlement.payload.outbound)
      allowed.add(`${scopeId(entry.identity.scope)}\0${entry.identity.operationId}`)
  const diagnostics = validateAdmissionDiagnostics(effective.values(), input.intent, allowed)
  if (!diagnostics.ok) return diagnostics
  return dispatchAdmission(input, last, priorNamespace)
}

function dispatchAdmission(
  input: AdmissionInput,
  last: RecoveryOwnerLineage['links'][number] | undefined,
  priorNamespace: LatchNamespace | null,
): Result<AdmissionResult> {
  const { uw, histories } = input
  if (last === undefined) {
    if (input.intent !== 'fresh') return fail('There is no interrupted owner to recover')
    return { ok: true, value: { status: 'fresh', afterClose: null, priorNamespace } }
  }
  if (last.control !== null) {
    if (last.control.payload.phase === 'adopt-decision') {
      return assessAdmissionClaim({
        intent: input.intent,
        claim: input.claim,
        control: last.control,
        priorNamespace,
        histories,
        graph: input.graph,
      })
    }
    if (input.intent !== 'fresh') return fail('Owner lineage is not eligible for fresh intake')
    const afterClose: RecoveryRef = {
      kind: 'fix-recovery',
      scope: { repository: last.control.repository, target: last.control.target },
      recordId: last.control.recordId,
    }
    return { ok: true, value: { status: 'fresh', afterClose, priorNamespace } }
  }
  if (input.intent !== 'recovery' || last.settlement === null || priorNamespace === null)
    return fail('An active or requestless owner still holds the destination')
  const selected = discoverSelectedRecoveryOwner({
    uw,
    histories,
    graph: input.graph,
    opened: {
      kind: 'fix-owner',
      scope: { repository: last.opening.repository, target: last.opening.target },
      recordId: last.opening.recordId,
    },
  })
  if (
    selected.status !== 'interrupted' ||
    selected.settled.recordId !== last.settlement.recordId ||
    !equalScope(selected.settled.scope, last.settlement)
  )
    return fail('Interrupted owner is not authenticated against current authority')
  return {
    ok: true,
    value: {
      status: 'recovery',
      opened: {
        kind: 'fix-owner',
        scope: { repository: last.opening.repository, target: last.opening.target },
        recordId: last.opening.recordId,
      },
      settled: {
        kind: 'fix-owner',
        scope: { repository: last.settlement.repository, target: last.settlement.target },
        recordId: last.settlement.recordId,
      },
      priorNamespace,
    },
  }
}
