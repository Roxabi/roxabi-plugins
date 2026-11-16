import type { ReservedRecordIdentity } from '../engine/fix-recovery-identities.ts'
import type { LatchNamespace, ProcessLifetime } from '../engine/fix-recovery-schema.ts'
import { inPreparationSettlement } from '../host/preparation-cohort.ts'
import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import type { acquireDestinationAdmissionLease } from '../omp/review-runtime/destination-admission-lease.ts'
import {
  recheckDestinationAdmissionLease,
  releaseDestinationAdmissionLease,
} from '../omp/review-runtime/destination-admission-lease.ts'
import type { FixSealedNoEntry } from './fix-fence-host.ts'
import { FixFenceHost } from './fix-fence-host.ts'
import type { FixFenceSnapshot } from './fix-fence-operations.ts'
import { publicationKey } from './fix-fence-operations.ts'
import type { FixRootLifetime } from './fix-fence-root.ts'
import { FixFenceRoot } from './fix-fence-root.ts'

type DestinationAdmissionLease = Extract<
  Awaited<ReturnType<typeof acquireDestinationAdmissionLease>>,
  { status: 'acquired' }
>['lease']
type QualifiedHost = Readonly<{ process: ProcessLifetime; namespace: LatchNamespace }>
type DestinationLeaseFacts = {
  owner: ReservedRecordIdentity<'fix-owner'>
  descriptor: DestinationAdmissionLease['descriptor']
  host: QualifiedHost | null
}

const owners = new WeakMap<NativeBatch, FixExecutionFence>()
/** In-memory facts of one originating Fix driver, not a recovery witness. */
export class FixExecutionFence extends FixFenceHost {
  #sealed = false
  #nativeEntered = false
  #planEntered = false
  #nativeUnknown = false
  #root = new FixFenceRoot()
  #driver: 'running' | 'canonical-result' | 'nonterminal-result' | 'threw' = 'running'
  #identity: Readonly<{ runId: string; operationId: string }> | null = null
  #ingressOpen = true
  #ingressPending = 0
  #ingressFailed = false
  #lease: DestinationAdmissionLease | null = null
  #leaseOwner: ReservedRecordIdentity<'fix-owner'> | null = null
  #qualifiedHost: QualifiedHost | null = null
  #leaseReleasing = false
  #confirmedOwner: ReservedRecordIdentity<'fix-owner'> | null = null
  #settleOwner: (() => Promise<{ ok: true } | { ok: false; diagnostics: string[] }>) | null = null
  protected operationIdentity(): Readonly<{ runId: string; operationId: string }> | null {
    return this.#identity
  }
  protected operationSealed(): boolean {
    return this.#sealed
  }
  protected hostDriverRunning(): boolean {
    return this.#driver === 'running'
  }
  protected hostHasIdentity(): boolean {
    return this.#identity !== null
  }
  protected hostCanSettle(): boolean {
    return this.#lease !== null && !this.#leaseReleasing
  }

  bindDestinationLease(
    lease: DestinationAdmissionLease,
    owner: ReservedRecordIdentity<'fix-owner'>,
    host: QualifiedHost | null,
  ): DestinationLeaseFacts {
    if (
      this.#sealed ||
      this.#lease !== null ||
      this.#identity === null ||
      this.#root.lifetime === null ||
      !this.#rootIsCurrent()
    )
      throw new Error('fix-destination-lease-unavailable')
    if (owner.runId !== this.#identity.runId || owner.operationId !== `${this.#identity.operationId}-${owner.recordId}`)
      throw new Error('fix-destination-lease-owner-mismatch')
    this.#lease = lease
    this.#leaseOwner = Object.freeze({ ...owner, scope: Object.freeze({ ...owner.scope }) })
    this.#qualifiedHost = host
    return { owner: this.#leaseOwner, descriptor: lease.descriptor, host }
  }

  /** Called only after the exact owner envelope has been read back from its journal. */
  confirmOpenedOwner(owner: ReservedRecordIdentity<'fix-owner'>): void {
    const leaseOwner = this.#leaseOwner
    const key = publicationKey({ ...owner, repository: owner.scope.repository, target: owner.scope.target })
    if (
      this.#sealed ||
      leaseOwner === null ||
      publicationKey({ ...leaseOwner, repository: leaseOwner.scope.repository, target: leaseOwner.scope.target }) !==
        key ||
      this.#confirmedOwner !== null ||
      !this.publicationObservations().some(
        (item) => publicationKey(item) === key && item.reserved && item.outcome === 'confirmed',
      )
    )
      throw new Error('fix-owner-confirmation-unavailable')
    this.#confirmedOwner = Object.freeze({ ...owner, scope: Object.freeze({ ...owner.scope }) })
  }

  bindOwnerSettlement(settle: () => Promise<{ ok: true } | { ok: false; diagnostics: string[] }>): void {
    if (this.#sealed || this.#confirmedOwner === null || this.#settleOwner !== null)
      throw new Error('fix-owner-settlement-binding-unavailable')
    this.#settleOwner = settle
  }

  async settleInterruptedOwner(): Promise<{ ok: true } | { ok: false; diagnostics: string[] }> {
    if (this.#driver === 'canonical-result' || this.#confirmedOwner === null) return { ok: true }
    if (this.#settleOwner === null) return { ok: false, diagnostics: ['fix-owner-settlement-unavailable'] }
    return this.#settleOwner()
  }

  destinationLeaseFacts(): DestinationLeaseFacts | null {
    return this.#lease === null || this.#leaseOwner === null
      ? null
      : { owner: this.#leaseOwner, descriptor: this.#lease.descriptor, host: this.#qualifiedHost }
  }
  /** Private host composition retains the same registered native handle through confirmation. */
  destinationLease(): DestinationAdmissionLease | null {
    return this.#lease
  }
  async recheckDestinationLease(): Promise<boolean> {
    if (this.#lease === null || this.#sealed || !this.#rootIsCurrent()) return false
    const checked = await recheckDestinationAdmissionLease(this.#lease)
    return checked.status === 'held' && !this.#sealed && this.#rootIsCurrent()
  }

  /** A sealed owner may recheck only inside its enrolled finite settlement lane. */
  async recheckSettlementLease(): Promise<boolean> {
    const cohort = this.operationCohort()
    if (
      this.#lease === null ||
      !this.#sealed ||
      cohort === null ||
      !inPreparationSettlement(cohort) ||
      this.#leaseReleasing ||
      !this.#rootIsCurrent()
    )
      return false
    const checked = await recheckDestinationAdmissionLease(this.#lease)
    return checked.status === 'held' && this.#rootIsCurrent()
  }

  /** Releases logical exclusion, not physical process drain or durable ownership. */
  async releaseDestinationLease(): Promise<Awaited<ReturnType<typeof releaseDestinationAdmissionLease>>> {
    const settlement = this.hostSettlement()
    if (
      this.#lease === null ||
      this.#driver === 'running' ||
      settlement === null ||
      this.activeHostSettlements() !== 0 ||
      this.#leaseReleasing
    )
      throw new Error('fix-destination-lease-not-ready-to-release')
    const lease = this.#lease
    this.#leaseReleasing = true
    try {
      await settlement
      await this.operationCohort()?.join()
      const result = await releaseDestinationAdmissionLease(lease)
      if (result.status === 'released') {
        this.#lease = null
        this.#leaseOwner = null
        this.#qualifiedHost = null
      }
      return result
    } finally {
      this.#leaseReleasing = false
    }
  }

  /** Originating factual candidate only; host-effect reconciliation and Core cuts remain required. */
  async observeSealedNoEntry(): Promise<FixSealedNoEntry> {
    if (
      this.#confirmedOwner === null ||
      this.#lease === null ||
      !this.#sealed ||
      this.#driver === 'running' ||
      this.#driver === 'canonical-result' ||
      this.stopStatus() === 'pending' ||
      this.stopStatus() === 'failed' ||
      this.#ingressOpen ||
      this.#ingressPending !== 0 ||
      this.#ingressFailed ||
      this.#nativeEntered ||
      this.#nativeUnknown ||
      this.#planEntered ||
      !this.#rootIsCurrent()
    )
      return { status: 'held', diagnostics: ['fix-owner-no-entry-unavailable'] }
    const owner = this.#confirmedOwner
    const host = await this.closeHostOperations()
    if (
      host.status !== 'joined' ||
      this.callbackObservations().some((item) => item.outcome !== 'returned') ||
      this.publicationObservations().some((item) => item.outcome === 'pending') ||
      !this.#rootIsCurrent()
    )
      return { status: 'held', diagnostics: ['fix-owner-host-join-unconfirmed'] }
    return { status: 'candidate', owner, host, publications: this.snapshot().publications }
  }

  bindIdentity(identity: { runId: string; operationId: string }): void {
    if (this.#sealed || this.#identity !== null) throw new Error('fix-identity-already-bound')
    this.#identity = Object.freeze({ runId: identity.runId, operationId: identity.operationId })
  }

  /** Accounts outer calls only; their nested subprocess effects need separate qualification. */
  async trackIngress<T>(call: () => Promise<T>): Promise<T> {
    if (!this.#ingressOpen || this.#sealed) throw new Error('fix-ingress-closed')
    this.#ingressPending += 1
    try {
      return await call()
    } catch (error) {
      this.#ingressFailed = true
      throw error
    } finally {
      this.#ingressPending -= 1
    }
  }

  closeIngress(): void {
    if (this.#ingressPending !== 0) throw new Error('fix-ingress-still-running')
    this.#ingressOpen = false
  }

  bindRoot(current: () => boolean, lifetime: FixRootLifetime): void {
    this.#root.bind(current, lifetime, this.#sealed)
  }

  #rootIsCurrent(): boolean {
    return this.#root.isCurrent()
  }
  rootCurrent(): boolean {
    return this.#rootIsCurrent()
  }

  bind(batch: NativeBatch): void {
    if (this.#sealed || owners.has(batch)) throw new Error('fix-native-admission-unavailable')
    owners.set(batch, this)
  }

  admit(batch: NativeBatch, admitNative: () => boolean): boolean {
    if (owners.get(batch) !== this || this.#sealed || !this.#rootIsCurrent()) return false
    try {
      if (!admitNative()) return false
      this.#nativeEntered = true
      return true
    } catch (error) {
      // Admission may have taken effect before an exceptional callback returned.
      this.#nativeUnknown = true
      throw error
    }
  }

  enterPlan(): boolean {
    if (this.#sealed || !this.#rootIsCurrent()) return false
    this.#planEntered = true
    return true
  }
  /** Driver termination alone never establishes closure of publications, Git or callbacks. */
  finishDriver(outcome: 'canonical-result' | 'nonterminal-result' | 'threw'): void {
    if (this.#driver !== 'running') throw new Error('fix-driver-already-terminated')
    this.#driver = outcome
    this.seal()
  }

  seal(): void {
    this.#rootIsCurrent()
    this.#sealed = true
  }
  snapshot(): FixFenceSnapshot {
    this.#rootIsCurrent()
    return {
      sealed: this.#sealed,
      nativeEntered: this.#nativeEntered,
      nativeUnknown: this.#nativeUnknown,
      planEntered: this.#planEntered,
      rootBound: this.#root.bound,
      rootLost: this.#root.lost,
      root: this.#root.lifetime,
      identity: this.#identity,
      driver: this.#driver,
      ingressOpen: this.#ingressOpen,
      ingressPending: this.#ingressPending,
      ingressFailed: this.#ingressFailed,
      publications: this.publicationObservations().map((item) => ({ ...item, diagnostics: [...item.diagnostics] })),
      callbacks: this.callbackObservations().map((item) => ({ ...item })),
    }
  }
}

/** Non-Fix batches continue through their own existing admission policy. */
export function admitFixBatch(batch: NativeBatch, admitNative: () => boolean): boolean {
  const owner = owners.get(batch)
  return owner === undefined ? admitNative() : owner.admit(batch, admitNative)
}
