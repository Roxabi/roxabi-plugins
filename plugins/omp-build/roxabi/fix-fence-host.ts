import type { ReservedRecordIdentity } from '../engine/fix-recovery-identities.ts'
import type { PreparationCohort, PreparationCohortResult } from '../host/preparation-cohort.ts'
import type { FixPublicationObservation } from './fix-fence-operations.ts'
import { FixFenceOperations } from './fix-fence-operations.ts'

export type FixSealedNoEntry =
  | {
      status: 'candidate'
      owner: ReservedRecordIdentity<'fix-owner'>
      host: Extract<PreparationCohortResult, { status: 'joined' }>
      publications: readonly FixPublicationObservation[]
    }
  | { status: 'held'; diagnostics: string[] }

/** Host-cohort enrollment and joining; the originating fence retains authority and lease. */
export abstract class FixFenceHost extends FixFenceOperations {
  #cohort: PreparationCohort | null = null
  #settlement: Promise<PreparationCohortResult> | null = null
  #activeSettlements = 0
  #stop: 'none' | 'pending' | 'joined' | 'failed' = 'none'

  protected abstract hostDriverRunning(): boolean
  protected abstract hostHasIdentity(): boolean
  protected abstract hostCanSettle(): boolean

  protected operationCohort(): PreparationCohort | null {
    return this.#cohort
  }
  protected hostSettlement(): Promise<PreparationCohortResult> | null {
    return this.#settlement
  }
  protected activeHostSettlements(): number {
    return this.#activeSettlements
  }
  protected stopStatus(): 'none' | 'pending' | 'joined' | 'failed' {
    return this.#stop
  }

  bindCohort(cohort: PreparationCohort): void {
    if (this.#cohort !== null || this.operationSealed()) throw new Error('fix-host-cohort-already-bound')
    this.#cohort = cohort
  }

  markHostUnknown(diagnostic: string): void {
    this.#cohort?.unknown(diagnostic)
  }

  beginStop(): void {
    if (this.callbacksClosed() || this.#stop !== 'none') throw new Error('fix-stop-admission-closed')
    this.#stop = 'pending'
  }

  finishStop(joined: boolean): void {
    if (this.#stop !== 'pending') throw new Error('fix-stop-not-pending')
    this.#stop = joined ? 'joined' : 'failed'
    if (!joined) this.markHostUnknown('fix-stop-unconfirmed')
  }

  /** Call only after the real driver and any stop operation have terminated. */
  closeHostOperations(): Promise<PreparationCohortResult> {
    if (this.#settlement !== null) return this.#settlement
    if ((this.hostHasIdentity() && this.hostDriverRunning()) || this.#stop === 'pending')
      throw new Error('fix-driver-still-running')
    const cohort = this.#cohort
    if (cohort === null)
      return Promise.resolve({
        status: 'unknown',
        diagnostics: ['fix-host-cohort-unavailable'],
        operations: [],
        disarmConfirmations: [],
      })
    this.closeCallbacks()
    this.#settlement = (async () => {
      await this.joinCallbacks()
      await this.joinPublications()
      cohort.seal()
      return cohort.join()
    })()
    return this.#settlement
  }

  /** Enrol finite closing reads/publications only after ordinary work has joined. */
  async runSettlement<T>(call: () => Promise<T>): Promise<T> {
    if (this.#cohort === null || this.#settlement === null || !this.hostCanSettle())
      throw new Error('fix-host-settlement-unavailable')
    this.#activeSettlements += 1
    try {
      await this.#settlement
      return await this.#cohort.runSettlement(call)
    } finally {
      this.#activeSettlements -= 1
    }
  }

  async joinSettlement(): Promise<PreparationCohortResult> {
    if (this.#cohort === null || this.#settlement === null)
      return {
        status: 'unknown',
        diagnostics: ['fix-host-cohort-unavailable'],
        operations: [],
        disarmConfirmations: [],
      }
    await this.#settlement
    return this.#cohort.join()
  }
}
