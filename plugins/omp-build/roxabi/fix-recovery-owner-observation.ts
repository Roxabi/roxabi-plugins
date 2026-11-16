import type { CanonicalRecord, DecodedHistory } from '../dist/contracts.js'
import { bindExternalRef, canonicalValueDigest } from '../dist/contracts.js'
import type { FixRecoveryObservation } from '../engine/fix-recovery-control-schema.ts'
import type { FixOwnerOpenedPayload, FixOwnerSettledPayload, RootLifetime } from '../engine/fix-recovery-schema.ts'
import {
  type DestinationAdmissionLease,
  recheckDestinationAdmissionLease,
} from '../omp/review-runtime/destination-admission-lease.ts'
import { observeCurrentLinuxHost, observePriorLinuxProcess } from '../omp/review-runtime/linux-execution-lease.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { hasOriginatingSettlement } from './fix-owner-settlement.ts'

type Owner = Extract<CanonicalRecord, { kind: 'fix-owner' }>
function confirmOwnerRecords(input: {
  opening: Owner & { payload: FixOwnerOpenedPayload }
  settlement: Owner & { payload: FixOwnerSettledPayload }
  histories: readonly DecodedHistory[]
}): FixActionResult<true> {
  const common = input.opening.payload.common
  const homes = input.histories.filter(
    (history) =>
      history.source.scope.repository === common.uw.repository &&
      history.source.scope.target === common.uw.target &&
      history.source.complete,
  )
  const home = homes[0]
  if (homes.length !== 1 || home === undefined) return failure('fix-recovery-owner-history-unavailable')
  for (const record of [input.opening, input.settlement]) {
    const bound = bindExternalRef({ scope: common.uw, kind: 'fix-owner', recordId: record.recordId }, home)
    if (!bound.ok || canonicalValueDigest(bound.value) !== canonicalValueDigest(record))
      return failure('fix-recovery-owner-unconfirmed')
  }
  const opened = input.settlement.payload.opened
  if (
    opened.scope.repository !== common.uw.repository ||
    opened.scope.target !== common.uw.target ||
    opened.recordId !== input.opening.recordId
  )
    return failure('fix-recovery-owner-settlement-mismatch')
  return { ok: true, value: true }
}
async function classifyPriorOwner(input: {
  host: Extract<FixOwnerOpenedPayload['common']['host'], { kind: 'linux-qualified' }>
  currentProcess: FixRecoveryObservation['host']['process']
  root: RootLifetime
  ownerRoot: RootLifetime
  settlement: Owner & { payload: FixOwnerSettledPayload }
}): Promise<FixActionResult<FixRecoveryObservation['host']['prior']>> {
  const prior = await observePriorLinuxProcess({ process: input.host.process, namespace: input.host.namespace })
  if (prior.state === 'positively-ended') {
    return {
      ok: true,
      value: {
        kind: 'exact-lifetime-ended',
        ended:
          prior.basis === 'pid-reused'
            ? { basis: 'pid-reused', observed: prior.observed }
            : { basis: 'absent-in-validated-procfs' },
      },
    }
  }
  if (
    prior.state === 'alive' &&
    canonicalValueDigest(input.currentProcess) === canonicalValueDigest(input.host.process) &&
    canonicalValueDigest(input.root) === canonicalValueDigest(input.ownerRoot) &&
    hasOriginatingSettlement(input.settlement, input.root, input.currentProcess)
  )
    return { ok: true, value: { kind: 'sealed-drained-live' } }
  return failure('fix-recovery-prior-owner-unconfirmed')
}

/** Observe exact prior lifetime or the retained capability from the actual live originating owner. */
export async function observeRecoveryOwner(input: {
  opening: Owner & { payload: FixOwnerOpenedPayload }
  settlement: Owner & { payload: FixOwnerSettledPayload }
  histories: readonly DecodedHistory[]
  lease: DestinationAdmissionLease
  root: RootLifetime
  rootCurrent: () => boolean
}): Promise<FixActionResult<FixRecoveryObservation['host']>> {
  if (!input.rootCurrent()) return failure('fix-recovery-root-changed')
  const before = await recheckDestinationAdmissionLease(input.lease)
  if (before.status !== 'held') return failure('fix-recovery-lease-unconfirmed')
  const common = input.opening.payload.common
  if (
    common.host.kind !== 'linux-qualified' ||
    canonicalValueDigest(before.descriptor) !== canonicalValueDigest(common.host.admission)
  )
    return failure('fix-recovery-owner-namespace-mismatch')
  const host = await observeCurrentLinuxHost()
  if (
    host.status !== 'qualified' ||
    canonicalValueDigest(host.namespace) !== canonicalValueDigest(common.host.namespace)
  )
    return failure('fix-recovery-owner-namespace-mismatch')
  const confirmed = confirmOwnerRecords(input)
  if (!confirmed.ok) return confirmed
  const observed = await classifyPriorOwner({
    host: common.host,
    currentProcess: host.process,
    root: input.root,
    ownerRoot: common.root,
    settlement: input.settlement,
  })
  if (!observed.ok) return observed
  const after = await recheckDestinationAdmissionLease(input.lease)
  const current = await observeCurrentLinuxHost()
  if (
    after.status !== 'held' ||
    current.status !== 'qualified' ||
    !input.rootCurrent() ||
    canonicalValueDigest(after.descriptor) !== canonicalValueDigest(before.descriptor) ||
    canonicalValueDigest(current.process) !== canonicalValueDigest(host.process) ||
    canonicalValueDigest(current.namespace) !== canonicalValueDigest(host.namespace)
  )
    return failure('fix-recovery-lease-unconfirmed')
  return {
    ok: true,
    value: { process: current.process, namespace: current.namespace, root: input.root, prior: observed.value },
  }
}
