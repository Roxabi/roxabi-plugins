import type { ReservedRecordIdentity } from '../engine/fix-recovery-identities.ts'
import type { PreparationCohort } from '../host/preparation-cohort.ts'
import { inPreparationSettlement, withPreparationAttribution } from '../host/preparation-cohort.ts'
import type { FixRootLifetime } from './fix-fence-root.ts'

export type FixPublicationObservation = Readonly<{
  repository: string
  target: string
  kind: string
  recordId: string
  runId: string
  operationId: string
  attribution: object
  reserved: boolean
  outcome: 'pending' | 'confirmed' | 'unconfirmed' | 'threw'
  diagnostics: readonly string[]
}>
export type FixCallbackObservation = Readonly<{
  kind: 'onChildResult' | 'onComplete' | 'onSettled' | 'onStop'
  outcome: 'pending' | 'returned' | 'threw'
  error: string | null
}>

export type FixFenceSnapshot = Readonly<{
  sealed: boolean
  nativeEntered: boolean
  nativeUnknown: boolean
  planEntered: boolean
  rootBound: boolean
  rootLost: boolean
  root: FixRootLifetime | null
  identity: Readonly<{ runId: string; operationId: string }> | null
  driver: 'running' | 'canonical-result' | 'nonterminal-result' | 'threw'
  ingressOpen: boolean
  ingressPending: number
  ingressFailed: boolean
  publications: readonly FixPublicationObservation[]
  callbacks: readonly FixCallbackObservation[]
}>
export function publicationKey(value: {
  repository: string
  target: string
  kind: string
  recordId: string
  runId: string
  operationId: string
}): string {
  return JSON.stringify([value.repository, value.target, value.kind, value.recordId, value.runId, value.operationId])
}

/** Private operation enrollment and joins for one fence, sharing its admission state. */
export abstract class FixFenceOperations {
  #publications: FixPublicationObservation[] = []
  #activePublications = new Set<Promise<void>>()
  #reservations = new Map<string, ReservedRecordIdentity<string>>()
  #callbacks: FixCallbackObservation[] = []
  #activeCallbacks = new Set<Promise<void>>()
  #callbacksClosed = false

  protected abstract operationCohort(): PreparationCohort | null
  protected abstract operationIdentity(): Readonly<{ runId: string; operationId: string }> | null
  protected abstract operationSealed(): boolean

  protected closeCallbacks(): void {
    this.#callbacksClosed = true
  }
  protected callbacksClosed(): boolean {
    return this.#callbacksClosed
  }
  protected callbackObservations(): readonly FixCallbackObservation[] {
    return this.#callbacks
  }
  protected publicationObservations(): readonly FixPublicationObservation[] {
    return this.#publications
  }

  async trackCallback<T>(kind: FixCallbackObservation['kind'], call: () => T | Promise<T>): Promise<T> {
    const cohort = this.operationCohort()
    if (this.#callbacksClosed) {
      cohort?.unknown('fix-native-callback-after-close')
      throw new Error('fix-native-callback-admission-closed')
    }
    const index = this.#callbacks.length
    this.#callbacks.push({ kind, outcome: 'pending', error: null })
    const joined = Promise.withResolvers<void>()
    this.#activeCallbacks.add(joined.promise)
    try {
      const value = await (cohort === null ? call() : cohort.run(call))
      this.#callbacks[index] = { kind, outcome: 'returned', error: null }
      return value
    } catch (error) {
      this.#callbacks[index] = { kind, outcome: 'threw', error: error instanceof Error ? error.message : String(error) }
      throw error
    } finally {
      this.#activeCallbacks.delete(joined.promise)
      joined.resolve()
    }
  }

  /** Joins enrolled native callbacks, not unregistered asynchronous work they may delegate. */
  async joinCallbacks(): Promise<void> {
    while (this.#activeCallbacks.size > 0) await Promise.all(this.#activeCallbacks)
  }

  /** Enrol a private reserved identity before its actual publisher can be invoked. */
  enrollPublicationReservation(reservation: ReservedRecordIdentity<string>): void {
    const cohort = this.operationCohort()
    const identity = this.operationIdentity()
    if (
      (this.operationSealed() && (cohort === null || !inPreparationSettlement(cohort))) ||
      identity === null ||
      reservation.runId !== identity.runId ||
      reservation.operationId !== `${identity.operationId}-${reservation.recordId}`
    )
      throw new Error('fix-publication-reservation-invalid')
    const key = publicationKey({
      ...reservation,
      repository: reservation.scope.repository,
      target: reservation.scope.target,
    })
    if (this.#reservations.has(key)) throw new Error('fix-publication-reservation-duplicate')
    this.#reservations.set(key, Object.freeze({ ...reservation, scope: Object.freeze({ ...reservation.scope }) }))
  }

  /** Immutable snapshots include enrolled operations even when publication never started. */
  outboundReservations(): readonly ReservedRecordIdentity<string>[] {
    return [...this.#reservations.values()].filter(
      (reservation) => reservation.kind !== 'fix-owner' && reservation.kind !== 'fix-recovery',
    )
  }

  /** Tracks the actual PR publisher call; this does not qualify nested transport effects. */
  async trackPublication<T extends { ok: true } | { ok: false; diagnostics: string[] }>(
    record: Pick<FixPublicationObservation, 'repository' | 'target' | 'kind' | 'recordId' | 'runId' | 'operationId'>,
    call: () => Promise<T>,
  ): Promise<T> {
    const cohort = this.operationCohort()
    if (this.#callbacksClosed && (cohort === null || !inPreparationSettlement(cohort))) {
      cohort?.unknown('fix-publication-after-close')
      throw new Error('fix-publication-admission-closed')
    }
    const identity = {
      repository: record.repository,
      target: record.target,
      kind: record.kind,
      recordId: record.recordId,
      runId: record.runId,
      operationId: record.operationId,
    }
    const reservedAttribution = this.#reservations.get(publicationKey(identity))
    const attribution = reservedAttribution ?? {}
    const metadata = { attribution, reserved: reservedAttribution !== undefined }
    const index = this.#publications.length
    this.#publications.push({ ...identity, ...metadata, outcome: 'pending', diagnostics: [] })
    const joined = Promise.withResolvers<void>()
    this.#activePublications.add(joined.promise)
    try {
      const result = await withPreparationAttribution(attribution, call)
      this.#publications[index] = {
        ...identity,
        ...metadata,
        outcome: result.ok ? 'confirmed' : 'unconfirmed',
        diagnostics: result.ok ? [] : [...result.diagnostics],
      }
      return result
    } catch (error) {
      this.#publications[index] = {
        ...identity,
        ...metadata,
        outcome: 'threw',
        diagnostics: [error instanceof Error ? error.message : String(error)],
      }
      throw error
    } finally {
      this.#activePublications.delete(joined.promise)
      joined.resolve()
    }
  }

  /** Joins calls enrolled so far; no assertion about other publishers or nested helpers. */
  async joinPublications(): Promise<void> {
    while (this.#activePublications.size > 0) await Promise.all(this.#activePublications)
  }
}
