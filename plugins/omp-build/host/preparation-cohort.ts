import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { githubPreparationKind } from './preparation-gh-classifier.ts'

export type PreparationOperationKind = 'git' | 'gh-read' | 'gh-write' | 'gh-append' | 'snapshot'
export type PreparationGhProvenance = {
  family: 'graphql' | 'pr-edit' | 'pr-merge' | 'api' | 'other'
  querySha256?: string
  fields: readonly string[]
}
export type PreparationOperationOutcome = {
  kind: PreparationOperationKind
  outcome: 'fulfilled' | 'rejected'
  exitCode?: number
  attribution?: object
  provenance?: PreparationGhProvenance
}
export type PreparationDisarmConfirmation = {
  attribution: object
  repository: string
  pr: number
  head: string
  authorizationReceiptId: number | null
}
export type PreparationCohortResult =
  | {
      status: 'joined'
      operations: readonly PreparationOperationOutcome[]
      disarmConfirmations: readonly PreparationDisarmConfirmation[]
    }
  | {
      status: 'unknown'
      diagnostics: string[]
      operations: readonly PreparationOperationOutcome[]
      disarmConfirmations: readonly PreparationDisarmConfirmation[]
    }

type Context = { cohort: PreparationCohort; settlement: boolean; attribution?: object }
const carrierKey = Symbol.for('roxabi.omp-build.preparation-cohort.context')
const existingCarrier: unknown = Reflect.get(globalThis, carrierKey)
let active: AsyncLocalStorage<Context>
if (Object.hasOwn(globalThis, carrierKey)) {
  if (
    existingCarrier === null ||
    typeof existingCarrier !== 'object' ||
    !('protocol' in existingCarrier) ||
    existingCarrier.protocol !== 1 ||
    !('storage' in existingCarrier) ||
    existingCarrier.storage === null ||
    typeof existingCarrier.storage !== 'object' ||
    !('run' in existingCarrier.storage) ||
    typeof existingCarrier.storage.run !== 'function' ||
    !('getStore' in existingCarrier.storage) ||
    typeof existingCarrier.storage.getStore !== 'function'
  )
    throw new Error('incompatible-preparation-cohort-context-protocol')
  Object.freeze(existingCarrier)
  active = existingCarrier.storage as AsyncLocalStorage<Context>
} else {
  active = new AsyncLocalStorage<Context>()
  Object.defineProperty(globalThis, carrierKey, {
    value: Object.freeze({ protocol: 1, storage: active }),
    writable: false,
    configurable: false,
  })
}

function exitCode(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { code?: unknown; exitCode?: unknown }
  return typeof candidate.exitCode === 'number'
    ? candidate.exitCode
    : typeof candidate.code === 'number'
      ? candidate.code
      : undefined
}

function observedOutcome(value: unknown): 'fulfilled' | 'rejected' {
  if (value !== null && typeof value === 'object' && 'ok' in value && value.ok === false) return 'rejected'
  const code = exitCode(value)
  return code !== undefined && code !== 0 ? 'rejected' : 'fulfilled'
}

/** Tracks host operations only; root authority and the driver are owned by the caller. */
export class PreparationCohort {
  #sealed = false
  #pending = new Set<Promise<void>>()
  #diagnostics = new Set<string>()
  #operations: PreparationOperationOutcome[] = []
  #disarmConfirmations: PreparationDisarmConfirmation[] = []
  #entered = false

  run<T>(fn: () => T): T {
    if (this.#sealed) throw new Error('preparation-cohort-sealed')
    this.#entered = true
    return active.run({ cohort: this, settlement: false }, fn)
  }

  runSettlement<T>(fn: () => T): T {
    if (!this.#sealed) throw new Error('preparation-cohort-not-sealed')
    return active.run({ cohort: this, settlement: true }, fn)
  }

  seal(): void {
    this.#sealed = true
  }

  async join(): Promise<PreparationCohortResult> {
    if (!this.#sealed) throw new Error('preparation-cohort-not-sealed')
    while (this.#pending.size > 0) await Promise.all([...this.#pending])
    const operations = [...this.#operations]
    const disarmConfirmations = [...this.#disarmConfirmations]
    if (!this.#entered)
      return { status: 'unknown', diagnostics: ['host-cohort-not-entered'], operations, disarmConfirmations }
    if (operations.length === 0)
      return { status: 'unknown', diagnostics: ['host-cohort-no-operations'], operations, disarmConfirmations }
    return this.#diagnostics.size === 0
      ? { status: 'joined', operations, disarmConfirmations }
      : { status: 'unknown', diagnostics: [...this.#diagnostics], operations, disarmConfirmations }
  }

  /** Enrol before starting the real operation and retain its observed outcome. */
  operation<T>(kind: PreparationOperationKind, fn: () => Promise<T>, provenance?: PreparationGhProvenance): Promise<T> {
    const context = active.getStore()
    if (context?.cohort !== this || (this.#sealed && !context.settlement)) {
      this.unknown('host-operation-after-seal')
      throw new Error('preparation-cohort-admission-closed')
    }
    const { promise: completion, resolve } = Promise.withResolvers<void>()
    this.#pending.add(completion)
    let operation: Promise<T>
    try {
      operation = Promise.resolve(fn())
    } catch (error) {
      this.#operations.push({
        kind,
        outcome: 'rejected',
        exitCode: exitCode(error),
        attribution: context.attribution,
        provenance,
      })
      this.#pending.delete(completion)
      resolve()
      throw error
    }
    return operation.then(
      (value) => {
        this.#operations.push({
          kind,
          outcome: observedOutcome(value),
          exitCode: exitCode(value),
          attribution: context.attribution,
          provenance,
        })
        this.#pending.delete(completion)
        resolve()
        return value
      },
      (error: unknown) => {
        this.#operations.push({
          kind,
          outcome: 'rejected',
          exitCode: exitCode(error),
          attribution: context.attribution,
          provenance,
        })
        this.#pending.delete(completion)
        resolve()
        throw error
      },
    )
  }

  syncOperation<T>(kind: PreparationOperationKind, fn: () => T): T {
    const context = active.getStore()
    if (context?.cohort !== this || (this.#sealed && !context.settlement)) {
      this.unknown('host-operation-after-seal')
      throw new Error('preparation-cohort-admission-closed')
    }
    try {
      const result = fn()
      this.#operations.push({ kind, outcome: observedOutcome(result), attribution: context.attribution })
      return result
    } catch (error) {
      this.#operations.push({ kind, outcome: 'rejected', attribution: context.attribution })
      throw error
    }
  }

  confirmDisarm(confirmation: PreparationDisarmConfirmation): void {
    const context = active.getStore()
    if (context?.cohort !== this || context.attribution !== confirmation.attribution) {
      throw new Error('host-disarm-attribution-mismatch')
    }
    this.#disarmConfirmations.push(confirmation)
  }

  unknown(diagnostic: string): void {
    this.#diagnostics.add(diagnostic)
  }
}

export function createPreparationCohort(): PreparationCohort {
  return new PreparationCohort()
}

export function trackPreparationOperation<T>(kind: PreparationOperationKind, fn: () => Promise<T>): Promise<T> {
  const cohort = currentPreparationCohort()
  return cohort === undefined ? fn() : cohort.operation(kind, fn)
}

/** Captures bounded, redacted GH command metadata for explaining a held owner. */
export function trackPreparationGhOperation<T>(args: readonly string[], fn: () => Promise<T>): Promise<T> {
  const cohort = currentPreparationCohort()
  if (cohort === undefined) return fn()
  const family =
    args[0] === 'api'
      ? args[1] === 'graphql'
        ? 'graphql'
        : 'api'
      : args[0] === 'pr' && args[1] === 'edit'
        ? 'pr-edit'
        : args[0] === 'pr' && args[1] === 'merge'
          ? 'pr-merge'
          : 'other'
  const query = family === 'graphql' ? args.find((value) => value.startsWith('query=')) : undefined
  const fields = args.flatMap((value, index) => {
    if (index === 0 || !['-f', '-F', '--field', '--raw-field'].includes(args[index - 1])) return []
    const name = value.split('=', 1)[0]
    return [
      /^(?:query|owner|name|number|expression|branch|cursor|id|sha|after|labelsCursor|childrenCursor|blockersCursor|e[0-9]+)$/.test(
        name,
      )
        ? name
        : '<other>',
    ]
  })
  const provenance: PreparationGhProvenance = {
    family,
    fields,
    ...(query === undefined ? {} : { querySha256: createHash('sha256').update(query.slice(6)).digest('hex') }),
  }
  return cohort.operation(githubPreparationKind(args), fn, provenance)
}

/** Associates nested host operations with the caller's authentic in-memory capability. */
export function withPreparationAttribution<T>(token: object, fn: () => T): T {
  const context = active.getStore()
  return context === undefined ? fn() : active.run({ ...context, attribution: token }, fn)
}

export function trackPreparationSyncOperation<T>(kind: PreparationOperationKind, fn: () => T): T {
  const cohort = currentPreparationCohort()
  return cohort === undefined ? fn() : cohort.syncOperation(kind, fn)
}

export function currentPreparationCohort(): PreparationCohort | undefined {
  return active.getStore()?.cohort
}

export function inPreparationSettlement(cohort: PreparationCohort): boolean {
  const context = active.getStore()
  return context?.cohort === cohort && context.settlement
}
